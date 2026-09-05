import http from 'k6/http';
import { sleep, check, group } from 'k6';
import encoding from 'k6/encoding';
import { browser } from 'k6/browser';

const BASELINE_URL = __ENV.BASELINE_URL || 'http://localhost:30301';
const STAGING_URL  = __ENV.STAGING_URL  || 'http://localhost:30302';

const WARMUP_S   = parseInt(__ENV.WARMUP_S   || '60',  10);
const RAMPUP_S   = parseInt(__ENV.RAMPUP_S   || '30',  10);
const MEASURE_S  = parseInt(__ENV.MEASURE_S  || '120', 10);
const RAMPDOWN_S = parseInt(__ENV.RAMPDOWN_S || '30',  10);
const VUS        = parseInt(__ENV.VUS        || '25',  10);

// Test credentials — seeded by the CI "Seed test data" step, not k6 itself.
// REST API writes below authenticate with these same regular passwords via
// Basic Auth, handled by the JSON Basic Authentication mu-plugin bundled in
// the image (mu-plugins/basic-auth.php) — a dev/debug-only auth handler
// from the WordPress REST API team's own repo, avoiding the cookie+nonce
// dance a real browser session would need just to authenticate a script.
const ADMIN_USER    = 'apia-admin';
const ADMIN_PASS    = 'Apia2024!';
const SECOND_USER   = 'apia-user2';
const SECOND_PASS   = 'Apia2024!';
const USERS = [
  { user: ADMIN_USER,  pass: ADMIN_PASS },
  { user: SECOND_USER, pass: SECOND_PASS },
];
function pickUser() { return USERS[Math.floor(Math.random() * USERS.length)]; }

// Multiple posts with different pre-seeded comment counts — VUs pick among
// them instead of all hitting the same row, same reasoning as gitea's
// multi-repo picking.
const TEST_POST_IDS = (__ENV.WP_TEST_POST_IDS || '2,3,4').split(',').map(Number);
function pickPostId() { return TEST_POST_IDS[Math.floor(Math.random() * TEST_POST_IDS.length)]; }

const STAGES = [
  { duration: `${WARMUP_S}s`,   target: Math.max(1, Math.floor(VUS * 0.2)) },
  { duration: `${RAMPUP_S}s`,   target: VUS },
  { duration: `${MEASURE_S}s`,  target: VUS },
  { duration: `${RAMPDOWN_S}s`, target: 0   },
];

// Browser scenarios start during the measurement window (after warmup + ramp-up)
const BROWSER_START_S = WARMUP_S + RAMPUP_S;

// k6 only breaks a metric out per-tag in its summary JSON if that exact
// tagged combination is referenced in a threshold — otherwise every
// env-tagged web vital collapses into one combined, undifferentiated
// number, and staging/baseline silently end up comparing against the same
// aliased value. These never fail (any p(95) passes); their only purpose is
// forcing k6 to actually populate the per-environment breakdown.
const CWV_VITALS = ['lcp', 'fcp', 'cls', 'ttfb', 'fid', 'inp'];
const cwvThresholds = {};
for (const vital of CWV_VITALS) {
  cwvThresholds[`browser_web_vital_${vital}{env:staging}`]  = ['p(95)<999999999'];
  cwvThresholds[`browser_web_vital_${vital}{env:baseline}`] = ['p(95)<999999999'];
}

export const options = {
  scenarios: {
    baseline: {
      executor: 'ramping-vus',
      exec: 'testBaseline',
      stages: STAGES,
      tags: { env: 'baseline' },
    },
    staging: {
      executor: 'ramping-vus',
      exec: 'testStaging',
      stages: STAGES,
      tags: { env: 'staging' },
    },
    browser_baseline: {
      executor: 'per-vu-iterations',
      exec: 'browserBaseline',
      vus: 2,
      iterations: 8,
      startTime: `${BROWSER_START_S}s`,
      tags: { env: 'baseline' },
      options: { browser: { type: 'chromium' } },
    },
    browser_staging: {
      executor: 'per-vu-iterations',
      exec: 'browserStaging',
      vus: 2,
      iterations: 8,
      startTime: `${BROWSER_START_S}s`,
      tags: { env: 'staging' },
      options: { browser: { type: 'chromium' } },
    },
  },
  thresholds: {
    'http_req_duration{env:staging}':  ['p(95)<2000'],
    'http_req_duration{env:baseline}': ['p(95)<9999999'],
    'http_req_failed{env:staging}':    ['rate<0.05'],
    // These two never fail (count is always >=0) — their only purpose is to
    // make k6 break "iterations" out per scenario in the summary export, so
    // the frontend agent can tell how many browser iterations actually
    // completed on each side instead of only seeing one combined total.
    'iterations{scenario:browser_staging}':  ['count>=0'],
    'iterations{scenario:browser_baseline}': ['count>=0'],
    ...cwvThresholds,
  },
};

// Test data (posts, comments, both users) is seeded by a dedicated CI step
// before k6 runs, via WordPress's install wizard + REST API over curl (no
// WP-CLI — see session notes) — not in a k6 setup() here, so a slow/failed
// seed fails its own step with a clear error instead of corrupting the
// measurement window.

function runTest(baseURL) {
  // Slightly more anonymous traffic, slightly less write traffic — closer
  // to what a typical low-write blog actually sees.
  const r = Math.random();
  if (r < 0.25) {
    anonymousJourney(baseURL);
  } else if (r < 0.82) {
    authenticatedJourney(baseURL);
  } else {
    writeJourney(baseURL);
  }
}

// Cookie login via wp-login.php — used for wp-admin page views, mirroring
// how a real logged-in user browses the dashboard. Separate from the Basic
// Auth (regular password, via the bundled mu-plugin) used for REST API
// writes below.
function login(baseURL, username, password) {
  // WordPress sets a wordpress_test_cookie on GET and requires it echoed
  // back on the login POST, to confirm the client accepts cookies at all —
  // skip this and login always fails with "Cookies are blocked" regardless
  // of valid credentials (confirmed by hand). Real browsers get this cookie
  // for free by loading the login page before submitting it.
  http.get(`${baseURL}/wp-login.php`, { timeout: '10s' });

  const loginRes = http.post(`${baseURL}/wp-login.php`, {
    log: username,
    pwd: password,
    'wp-submit': 'Log In',
    redirect_to: `${baseURL}/wp-admin/`,
    testcookie: '1',
  }, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    redirects: 5,
    timeout: '10s',
  });

  check(loginRes, {
    'login succeeded': (r) => r.status === 200 && !r.url.includes('wp-login.php'),
  });

  const jar = loginRes.cookies;
  const cookies = Object.entries(jar)
    .map(([k, v]) => `${k}=${v[0].value}`)
    .join('; ');
  return { Cookie: cookies };
}

function anonymousJourney(baseURL) {
  group('anonymous', () => {
    // Homepage
    check(http.get(`${baseURL}/`, { timeout: '10s' }), {
      'homepage 200': (r) => r.status === 200,
    });
    sleep(0.5);

    // A specific post, plain-permalink form — avoids depending on whether
    // pretty permalinks are configured, same robustness reasoning as
    // keeping this query-string based rather than path-based.
    const postId = pickPostId();
    check(http.get(`${baseURL}/?p=${postId}`, { timeout: '10s' }), {
      'post 200': (r) => r.status === 200,
    });
    sleep(0.5);

    // Search
    check(http.get(`${baseURL}/?s=test`, { timeout: '10s' }), {
      'search 200': (r) => r.status === 200,
    });
    sleep(0.5);

    // REST API — list published posts. Uses the ?rest_route= query-var form,
    // not the pretty /wp-json/ path — a fresh install defaults to Plain
    // permalinks and the base php:8.3-apache image has no AllowOverride set,
    // so .htaccess-based rewrites (which /wp-json/ depends on) never take
    // effect. ?rest_route= is core's own always-available fallback.
    check(http.get(`${baseURL}/?rest_route=/wp/v2/posts&per_page=10`, { timeout: '10s' }), {
      'api posts 200': (r) => r.status === 200,
    });
    sleep(1);
  });
}

function authenticatedJourney(baseURL) {
  group('authenticated', () => {
    const { user, pass } = pickUser();
    const sessionHeaders = login(baseURL, user, pass);
    const postId = pickPostId();

    sleep(0.5);

    group('dashboard', () => {
      check(http.get(`${baseURL}/wp-admin/`, { headers: sessionHeaders, timeout: '10s' }), {
        'dashboard 200': (r) => r.status === 200,
      });
    });
    sleep(0.5);

    group('post edit screen', () => {
      check(http.get(`${baseURL}/wp-admin/post.php?post=${postId}&action=edit`, {
        headers: sessionHeaders, timeout: '10s',
      }), {
        'post edit 200': (r) => r.status === 200,
      });
    });
    sleep(0.5);

    group('comments list', () => {
      check(http.get(`${baseURL}/wp-admin/edit-comments.php`, {
        headers: sessionHeaders, timeout: '10s',
      }), {
        'comments admin 200': (r) => r.status === 200,
      });
    });
    sleep(0.5);

    group('api me', () => {
      check(http.get(`${baseURL}/?rest_route=/wp/v2/users/me`, {
        headers: {
          Authorization: `Basic ${encoding.b64encode(user + ':' + pass)}`,
        },
        // A fresh, empty jar — this VU's login() above left real WordPress
        // session cookies in the default jar, and if those get attached
        // here too, WP's cookie-auth path wins over Basic Auth and demands
        // an X-WP-Nonce we don't send, causing a 401 on any endpoint that
        // actually enforces auth (confirmed by hand: /users/me 401s with
        // stale cookies + Basic Auth, even though Basic Auth alone works).
        jar: new http.CookieJar(),
        timeout: '10s',
      }), {
        'api me 200': (r) => r.status === 200,
      });
    });
    sleep(0.5);

    group('api posts mine', () => {
      check(http.get(`${baseURL}/?rest_route=/wp/v2/posts&per_page=10&status=publish`, {
        headers: {
          Authorization: `Basic ${encoding.b64encode(user + ':' + pass)}`,
        },
        jar: new http.CookieJar(),
        timeout: '10s',
      }), {
        'api posts auth 200': (r) => r.status === 200,
      });
    });
    sleep(0.5);

    group('profile', () => {
      check(http.get(`${baseURL}/wp-admin/profile.php`, {
        headers: sessionHeaders, timeout: '10s',
      }), {
        'profile 200': (r) => r.status === 200,
      });
    });
    sleep(1);
  });
}

// Write-heavy journey — creates a comment on an existing post and a new
// draft post, under a randomly picked user against a randomly picked post,
// so writes land on varied rows too. Uses Basic Auth via the seeded user's
// regular password (mu-plugins/basic-auth.php), same shape as gitea's
// authHeaders pattern.
function writeJourney(baseURL) {
  group('write', () => {
    const { user, pass } = pickUser();
    const postId = pickPostId();
    // Fresh, empty jar — this VU may have run authenticatedJourney's login()
    // in a prior iteration (VU cookie jars persist across iterations, not
    // just within one), and a leftover session cookie makes WP's cookie-auth
    // path win over Basic Auth and demand a nonce we don't send. See the
    // same note in authenticatedJourney's 'api me' group.
    const authParams = {
      headers: {
        Authorization: `Basic ${encoding.b64encode(user + ':' + pass)}`,
        'Content-Type': 'application/json',
      },
      jar: new http.CookieJar(),
      timeout: '10s',
    };

    sleep(0.3);

    group('create comment', () => {
      const n = Math.floor(Math.random() * 10000);
      check(http.post(`${baseURL}/?rest_route=/wp/v2/comments`,
        JSON.stringify({ post: postId, content: `Load-test comment ${n} from ${user}.` }),
        authParams), {
        'create comment 201': (r) => r.status === 201,
      });
    });
    sleep(0.3);

    group('create draft post', () => {
      const n = Math.floor(Math.random() * 10000);
      check(http.post(`${baseURL}/?rest_route=/wp/v2/posts`,
        JSON.stringify({ title: `Load-test post ${n}`, content: `Created by ${user} during load test.`, status: 'draft' }),
        authParams), {
        'create post 201': (r) => r.status === 201,
      });
    });
    sleep(0.5);
  });
}

export function testBaseline() { runTest(BASELINE_URL); }
export function testStaging()  { runTest(STAGING_URL);  }

// ── Browser scenarios — Core Web Vitals collection ────────────────────────────

const BROWSER_PAGES = ['/', '/wp-login.php', '/?s=test'];

async function runBrowser(baseURL) {
  const context = await browser.newContext();
  try {
    for (const path of BROWSER_PAGES) {
      const page = await context.newPage();
      try {
        await page.goto(baseURL + path, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1000); // let CWV settle
      } catch (_) {
        // page errors don't fail the scenario — CWV collected up to the error
      } finally {
        await page.close();
      }
      sleep(1);
    }
  } finally {
    await context.close();
  }
}

export async function browserBaseline() { await runBrowser(BASELINE_URL); }
export async function browserStaging()  { await runBrowser(STAGING_URL);  }
