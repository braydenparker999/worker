export default {
  async fetch(request) {
    const url = new URL(request.url);
    const q = url.searchParams.get('url');

    // If no URL, show a simple home page (can be our Oasis-like UI later)
    if (!q) {
      return new Response(homePageHTML, { headers: { 'Content-Type': 'text/html' } });
    }

    const targetUrl = decodeURIComponent(q);

    // Redirect YouTube to Invidious
    if (targetUrl.includes('youtube.com/watch')) {
      const videoId = new URL(targetUrl).searchParams.get('v');
      if (videoId) {
        return Response.redirect(`https://yewtu.be/watch?v=${videoId}`, 302);
      }
    }

    try {
      const response = await fetch(targetUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; rv:91.0) Gecko/20100101 Firefox/91.0' },
        redirect: 'follow'
      });

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('text/html')) {
        let html = await response.text();

        // Insert our mini toolbar at the top of the page
        html = html.replace(/<\/body>/i, toolBarHTML + '</body>');

        // Rewrite links so they stay inside the proxy
        html = html.replace(/(<a\s[^>]*href=")([^"]+)(")/gi, (match, pre, href, post) => {
          if (href.startsWith('#') || href.startsWith('javascript:')) return match;
          try {
            const absolute = new URL(href, targetUrl).href;
            return pre + '/proxy?url=' + encodeURIComponent(absolute) + post;
          } catch(e) { return match; }
        });

        return new Response(html, { headers: { 'Content-Type': 'text/html' } });
      }
      // For other content (images, CSS, etc.) just pass through
      return response;
    } catch (err) {
      return new Response('Proxy error: ' + err.message, { status: 500 });
    }
  }
};

// A small toolbar injected into every page
const toolBarHTML = `
<div id="oasis-toolbar" style="position:fixed; top:0; left:0; right:0; background:#111; padding:10px; z-index:99999; display:flex; gap:8px; font-family:Arial;">
  <input id="oasis-url" type="text" placeholder="Enter URL or search" style="flex:1; padding:8px; border:none; border-radius:5px; background:#222; color:#fff;">
  <button onclick="oasisGo()" style="padding:8px 16px; background:#f00; border:none; border-radius:5px; color:#fff; font-weight:bold;">Go</button>
</div>
<script>
  function oasisGo() {
    const val = document.getElementById('oasis-url').value.trim();
    let final = val;
    if (!val.startsWith('http://') && !val.startsWith('https://')) {
      if (val.includes('.') && !val.includes(' ')) final = 'https://' + val;
      else final = 'https://www.google.com/search?q=' + encodeURIComponent(val);
    }
    window.location.href = '/proxy?url=' + encodeURIComponent(final);
  }
  document.addEventListener('keypress', function(e) {
    if (e.key === 'Enter' && document.activeElement.id === 'oasis-url') oasisGo();
  });
</script>
<style> body { margin-top: 50px !important; } </style>
`;

// A default home page if someone visits the worker root
const homePageHTML = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="background:#111;color:#fff;font-family:sans-serif;">
<div style="padding:20px;">
  <h1>Oasis Browser</h1>
  <input id="u" type="text" placeholder="Enter website..." style="width:70%;padding:10px;">
  <button onclick="go()">Go</button>
</div>
<script>
  function go() {
    const val = document.getElementById('u').value.trim();
    let final = val;
    if (!val.startsWith('http://') && !val.startsWith('https://')) {
      if (val.includes('.') && !val.includes(' ')) final = 'https://' + val;
      else final = 'https://www.google.com/search?q=' + encodeURIComponent(val);
    }
    window.location.href = '/proxy?url=' + encodeURIComponent(final);
  }
</script></body></html>`;
