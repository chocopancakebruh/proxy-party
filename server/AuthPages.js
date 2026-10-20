function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function loginPage(account, requiresKey) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proxy Party · ${escapeHtml(account.label)} authentication</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;line-height:1.5">
<p><a href="/dashboard/">Proxy Party</a></p><h1>${escapeHtml(account.label)} authentication</h1>
<p>Each Claude account has its own saved login.</p>
${requiresKey ? '<p><label>Proxy password <input id="proxy-key" type="password" autocomplete="off"></label></p>' : ''}
<button id="start" type="button">Open Anthropic authorization</button>
<p>Paste the complete <code>code#state</code> value shown by Anthropic.</p>
<form id="code-form"><input id="manual-code" autocomplete="off" required style="width:100%;box-sizing:border-box;padding:10px" placeholder="code#state"><button type="submit" style="margin-top:12px">Finish login</button></form>
<p id="status" role="status"></p>
<script>
const authBase = ${JSON.stringify(account.authBase)};
const status = document.getElementById('status');
document.getElementById('start').addEventListener('click', async () => {
  const popup = window.open('about:blank', '_blank');
  if (popup) popup.opener = null;
  status.textContent = 'Creating authorization request…';
  try {
    const key = document.getElementById('proxy-key')?.value || '';
    const response = await fetch(authBase + '/get-url', {headers: key ? {'X-Proxy-Key': key} : {}});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Could not create authorization URL');
    if (popup) popup.location.href = data.url;
    else throw new Error('Allow popups and try again.');
    status.textContent = 'Authorization opened in a new tab.';
  } catch (error) {
    popup?.close();
    status.textContent = error.message;
  }
});
document.getElementById('code-form').addEventListener('submit', async event => {
  event.preventDefault();
  status.textContent = 'Completing login…';
  try {
    const response = await fetch(authBase + '/callback', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({manual_code:document.getElementById('manual-code').value.trim()})});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Authentication failed');
    status.textContent = data.message;
    document.getElementById('manual-code').value = '';
  } catch (error) { status.textContent = error.message; }
});
</script></body></html>`;
}

function resultPage(title, message) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Proxy Party · ${escapeHtml(title)}</title></head><body style="font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px"><p><a href="/dashboard/">Proxy Party</a></p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

module.exports = { loginPage, resultPage };
