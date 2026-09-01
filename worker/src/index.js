// The catalog documents are served as static assets at their exact paths (catalog.json,
// <name>/latest, <name>/index.json) -- their bytes are covered by the signature, so nothing
// rewrites them. This script exists only to give the bare domain a human-readable page instead
// of a raw 404; every other path is forwarded to the assets untouched.
const LANDING = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FulDC++ extensions</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 15px/1.6 system-ui, sans-serif; background: #0f1115; color: #e6e6e6; }
  main { max-width: 640px; margin: 0 auto; padding: 3rem 1.25rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  .sub { color: #9aa0a6; margin: 0 0 2rem; }
  code { background: #1c2027; padding: .15em .4em; border-radius: 4px; font-size: .92em; }
  a { color: #6ea8fe; }
  ul { padding-left: 1.2rem; }
  li { margin: .35rem 0; }
  .card { background: #171a1f; border: 1px solid #262b33; border-radius: 10px; padding: 1rem 1.25rem; margin: 1.25rem 0; }
  footer { color: #6b7178; margin-top: 2.5rem; font-size: .9em; }
</style>
</head>
<body>
<main>
  <h1>FulDC++ extensions</h1>
  <p class="sub">The extension catalog served to the FulDC++ client.</p>
  <p>This host serves the catalog that the FulDC++ Extensions window, its web interface and the
  automatic updater read. It is not a page to browse &mdash; the client fetches the documents
  directly.</p>
  <div class="card">
    <strong>Endpoints</strong>
    <ul>
      <li><a href="/catalog.json">/catalog.json</a> &mdash; the signed list of extensions</li>
      <li><code>/&lt;name&gt;/latest</code> and <code>/&lt;name&gt;/index.json</code> &mdash; per-package documents</li>
    </ul>
  </div>
  <p>The packages themselves are published as releases of
  <a href="https://github.com/fuldcpp/extensions">github.com/fuldcpp/extensions</a>.
  To install one, open <strong>Extensions</strong> in FulDC++.</p>
  <footer><a href="https://fuldcpp.net/">fuldcpp.net</a></footer>
</main>
</body>
</html>`;

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/' || pathname === '/index.html') {
      return new Response(LANDING, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'public, max-age=300',
        },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
