'use strict';
const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const toast = document.querySelector('#toast');
let state, customers = [], page = 'Overview', authMode = 'login', lookup = '', noticeTimer;
let registrationDetails, recoveryDetails;
const escape = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const brand = '<a class="brand" href="/"><img src="/novamacro.png" alt=""><span>NovaMacro</span></a>';
const date = unix => unix ? new Intl.DateTimeFormat('en', { dateStyle:'medium', timeStyle:'short' }).format(unix * 1000) : '—';
const duration = value => value === null ? 'Lifetime' : value ? value + ' days' : '—';
const active = () => state.license?.status === 'Active';
const status = value => 'status ' + (value === 'Active' ? 'good' : ['Revoked','Expired'].includes(value) ? 'bad' : 'wait');
const badge = value => '<span class="' + status(value) + '">' + escape(value) + '</span>';
const size = bytes => typeof bytes === 'number' ? (bytes/(1024*1024)).toFixed(1) + ' MB' : '—';

async function api(url, body) {
  const response = await fetch(url, body === undefined ? {} : {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function notify(text) {
  toast.textContent = text;
  toast.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { toast.hidden = true; }, 3500);
}
function formHandler(target, action) {
  if (!target) return;
  target.addEventListener('submit', async event => {
    event.preventDefault();
    const button = target.querySelector('button[type=submit]');
    const message = target.querySelector('.error');
    button.disabled = true;
    message.textContent = '';
    try { await action(Object.fromEntries(new FormData(target)), target); }
    catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  });
}
async function refresh() {
  state = await api('/api/state');
  if (state.account?.role === 'admin') {
    ({ customers } = await api('/api/admin/customers'));
    if (!['Customers','Downloads'].includes(page)) page = 'Customers';
  }
  render();
}
function showDialog(title, html) {
  dialog.innerHTML = '<div class="stack"><div class="dialog-header"><h2 id="dialog-title">' + escape(title)
    + '</h2><button type="button" class="link-button" id="close-dialog">Close</button></div>' + html + '</div>';
  dialog.querySelector('#close-dialog').onclick = () => dialog.close();
  if (!dialog.open) dialog.showModal();
}
function showKey(title, value, description, label = 'Key') {
  showDialog(title, '<p class="muted">' + escape(description) + '</p><textarea class="key" aria-label="' + escape(label) + '" readonly>'
    + escape(value) + '</textarea><div class="actions"><button type="button" class="action primary" id="copy-key">Copy ' + escape(label.toLowerCase()) + '</button></div>');
  dialog.querySelector('#copy-key').onclick = async () => {
    const key = dialog.querySelector('textarea');
    try { await navigator.clipboard.writeText(key.value); notify(label + ' copied.'); }
    catch { key.select(); notify(label + ' selected. Press Ctrl+C to copy.'); }
  };
}
dialog.addEventListener('close', () => dialog.replaceChildren());

function passwordField(isNew) {
  return `<label>${isNew?'New password':'Password'}<input name="password" type="password" required maxlength="128"
    ${isNew?'minlength="10" autocomplete="new-password"':'autocomplete="current-password"'}></label>`;
}
function pinFields(isNew) {
  const attributes = 'type="password" inputmode="numeric" pattern="[0-9]{6,8}" minlength="6" maxlength="8" required';
  return `<label>Personal PIN<input name="pin" ${attributes} autocomplete="${isNew?'new-password':'current-password'}"></label>
    ${isNew?`<label>Confirm PIN<input name="confirmPin" ${attributes} autocomplete="new-password"></label>`:''}`;
}
function confirmedPin(values) {
  if (values.pin !== values.confirmPin) throw new Error('The PINs do not match.');
  return values.pin;
}
function setAuthMode(mode) {
  authMode = mode;
  renderAuth();
}
function resetAuth() {
  registrationDetails = undefined;
  recoveryDetails = undefined;
  authMode = 'login';
}
function renderAuth() {
  const mode = state.pending || authMode;
  const credentials = mode === 'login' || mode === 'register';
  const registration = mode === 'register';
  const newPin = mode === 'setup' || mode === 'register-pin';
  const recovery = mode === 'recover' || mode === 'recover-credentials';
  const title = {
    login:'Sign in', register:'Create an account', 'register-pin':'Create your personal PIN',
    setup:'Create your personal PIN', verify:'Enter your personal PIN',
    recover:'Recover your account', 'recover-credentials':'Set new credentials'
  }[mode];
  const button = {
    login:'Continue', register:'Continue', 'register-pin':'Create account',
    setup:'Save PIN and sign in', verify:'Sign in', recover:'Continue', 'recover-credentials':'Reset credentials'
  }[mode];
  const description = credentials ? 'Manage your Premium license and Windows download.' :
    newPin ? 'Choose 6 to 8 digits. You’ll enter this PIN each time you sign in.' :
    mode === 'verify' ? 'Enter the PIN you chose for your NovaMacro account.' :
    mode === 'recover' ? 'Paste the one-time recovery code you received in your private support ticket.' :
    'Choose a new personal PIN with 6 to 8 digits.';
  const emailField = '<label>Email<input name="email" type="email" required maxlength="254" autocomplete="username"></label>';
  const fields = credentials ? `
    ${registration?'<label>Name<input name="name" minlength="2" maxlength="80" required autocomplete="nickname"></label>':''}
    ${emailField}
    ${passwordField(registration)}` :
    mode === 'recover' ? '<label>Recovery code<input name="code" required maxlength="36" placeholder="NMR-…" autocomplete="off" spellcheck="false"></label>' :
    mode === 'recover-credentials' ? (recoveryDetails.needsEmail ? emailField : '') + passwordField(true) + pinFields(true) :
    pinFields(newPin);
  app.innerHTML = `<main class="auth"><section class="auth-panel">
    ${brand}
    <div class="card">
      <div class="auth-heading"><h1>${title}</h1><p class="muted">${description}</p></div>
      <form id="auth-form" class="stack">
        ${fields}
        <p class="error" role="alert"></p>
        <button type="submit" class="action primary">${button}</button>
      </form>
      ${mode === 'verify' || mode === 'login'?'<button type="button" class="link-button" id="recover-auth">Forgot password or PIN?</button>':''}
      ${mode === 'recover'?'<a href="' + escape(state.supportUrl) + '" target="_blank" rel="noopener noreferrer">Open a private Discord support ticket</a>':''}
    </div>
    <p class="auth-switch">
      ${credentials ? (registration?'Already have an account? ':'New to NovaMacro? ') : ''}
      <button type="button" class="link-button" id="switch-auth">${mode === 'login'?'Create an account':
    mode === 'register'?'Sign in':mode === 'register-pin'?'Back to account details':recovery?'Back to sign in':'Cancel sign-in'}</button>
    </p>
  </section></main>`;
  const form = document.querySelector('#auth-form');
  if (registration && registrationDetails) {
    for (const key of ['name','email','password']) form.elements[key].value = registrationDetails[key];
  }
  if (!credentials) form.querySelector('input')?.focus();
  document.querySelector('#switch-auth').onclick = async () => {
    if (mode === 'login') return setAuthMode('register');
    if (mode === 'register-pin') return setAuthMode('register');
    try {
      if (state.pending) await api('/api/auth/cancel',{});
      resetAuth();
      await refresh();
    } catch (error) { form.querySelector('.error').textContent = error.message; }
  };
  const recoveryButton = document.querySelector('#recover-auth');
  if (recoveryButton) recoveryButton.onclick = async () => {
    try {
      if (state.pending) {
        await api('/api/auth/cancel',{});
        state.pending = null;
      }
      setAuthMode('recover');
    } catch (error) { form.querySelector('.error').textContent = error.message; }
  };
  formHandler(form, async values => {
    if (registration) {
      registrationDetails = values;
      return setAuthMode('register-pin');
    }
    if (mode === 'recover') {
      const code = values.code.trim();
      recoveryDetails = { code, ...await api('/api/recover/check',{ code }) };
      return setAuthMode('recover-credentials');
    }
    if (mode === 'register-pin') {
      await api('/api/register',{ ...registrationDetails, pin:confirmedPin(values) });
    } else if (mode === 'login') {
      await api('/api/login',values);
    } else if (mode === 'recover-credentials') {
      await api('/api/recover',{ code:recoveryDetails.code, pin:confirmedPin(values), password:values.password, email:values.email });
      notify('Credentials updated. You can sign in now.');
    } else {
      await api('/api/auth/pin',{ pin:newPin?confirmedPin(values):values.pin });
    }
    resetAuth();
    page = 'Overview';
    await refresh();
  });
}
function metric(label, value) {
  return '<div><dt>' + escape(label) + '</dt><dd>' + escape(value) + '</dd></div>';
}
function activity(events) {
  if (!events.length) return '<p class="muted">No activity yet.</p>';
  return '<div class="table-wrap"><table><thead><tr><th>Event</th><th>Time</th></tr></thead><tbody>' +
    events.map(item => '<tr><td>' + escape(item.kind) + '</td><td>' + escape(date(item.at)) + '</td></tr>').join('') + '</tbody></table></div>';
}
function welcomePay() {
  const license = state.license;
  if (license?.status === 'Awaiting activation') return `<div class="card stack">
    <h2>Activate your portal key</h2>
    <p class="muted">Your payment has been approved. Enter the NMP key you received to unlock Premium.</p>
    <form class="stack" id="redeem">
      <label>Portal key<input name="code" placeholder="NMP-…" maxlength="40" required autocomplete="off" spellcheck="false"></label>
      <p class="error" role="alert"></p>
      <div class="actions"><button type="submit" class="action primary">Activate key</button></div>
    </form>
  </div>`;
  if (license?.status === 'Active') return `<div class="card stack"><h2>Your license</h2>
    <dl class="metric-list">
      ${metric('Portal key','NMP-•••••' + license.suffix)}
      ${metric('Valid until',license.expiresAt ? date(license.expiresAt) : 'Lifetime')}
      ${metric('Activated',date(license.activatedAt))}
      ${metric('Windows PCs',license.device?'1 of 1':'0 of 1')}
    </dl><div class="actions"><button type="button" class="action" data-page="Devices">Manage device</button></div></div>`;
  return `<div class="card stack"><h2>${license?'Your license needs attention':'Get NovaMacro Premium'}</h2>
    <p class="muted">${license?'Open a support ticket to review your license.':'Open a purchase ticket on Discord. The owner will verify your payment and issue a portal key for your account.'}</p>
    <div class="actions"><a class="button" rel="noopener noreferrer" target="_blank" href="${escape(state.supportUrl)}">Open Discord</a></div></div>`;
}
function download() {
  const product = state.release;
  const allowed = active() && product.available;
  return `<section class="card stack"><div>
    <h2>NovaMacro Premium for Windows</h2>
    <p class="muted">${active()?(product.available?'Download the ZIP and launch NovaMacro-Premium.exe.':'The download is being prepared.'):'Activate your portal key to unlock this download.'}</p>
    </div>
    ${product.available?`<small>Version ${escape(product.version)} · 64-bit · ${size(product.size)}</small>`:''}
    <div class="actions">${allowed?'<a class="button primary" href="/download/premium">Download Premium</a>':
      '<button type="button" class="action" disabled>Download Premium</button>'}</div>
    ${allowed&&product.sha256?`<div class="release-meta"><small>SHA-256</small><br><code>${escape(product.sha256)}</code></div>`:''}
  </section>`;
}
function overview() {
  return `<div class="crumb">Licenses / Overview</div><div class="hero"><img src="/novamacro.png" alt="">
    <div class="hero-text"><h1>NovaMacro Premium</h1>${badge(state.license?.status || 'Pending approval')}</div></div>
    <div class="grid">${welcomePay()}${download()}</div>`;
}
function devices() {
  const device = state.license?.device;
  return `<div class="page-header"><div class="stack"><h1>Devices</h1>
    <p class="muted">Link one Windows PC to your Premium license.</p></div></div>
    ${!active()?'<div class="card"><p>Activate your portal key first to link your PC.</p></div>':`
    <div class="grid">
      <div class="card stack"><h2>${device?'Your linked PC':'Link your PC'}</h2>
        ${device?`<dl class="metric-list">
          ${metric('Device',device.name)}${metric('Device code',device.code)}
          ${metric('Linked',date(device.linkedAt))}${metric('Last verified',date(device.lastSeen))}
          </dl><p class="muted">Contact support to move your license to another PC.</p>`:
          '<p class="muted">Copy the NM2 Device Code from the Premium app’s activation screen.</p>'}
        <form class="stack" id="device">
          ${device?`<input type="hidden" name="device" value="${escape(device.code)}">`:
            '<label>Device Code<input name="device" placeholder="NM2-…" maxlength="42" required autocomplete="off" spellcheck="false"></label><label>PC name <input name="name" placeholder="Gaming PC" maxlength="60"></label>'}
          <p class="error" role="alert"></p>
          <div class="actions"><button type="submit" class="action primary">${device?'Get desktop activation key':'Link device and get key'}</button></div>
        </form>
      </div>
      <div class="card stack"><h2>Activate the desktop app</h2><ol class="plain-list">
        <li>Download and extract the Premium ZIP.</li><li>Open the app and copy its Device Code.</li>
        <li>Get your desktop activation key here and paste it into the app.</li></ol></div>
    </div>`}
  `;
}
function adminRows() {
  const list = customers.filter(item => [item.name,item.email,item.discordId,item.license?.status,item.method]
    .some(value => String(value || '').toLowerCase().includes(lookup.toLowerCase())));
  if (!list.length) return '<p class="muted">' + (customers.length?'No customers match your search.':'New registrations will appear here.') + '</p>';
  return `<div class="table-wrap"><table><thead><tr><th>Account</th><th>Registered</th><th>License</th><th></th></tr></thead><tbody>
    ${list.map(item=>`<tr><td>${escape(item.name)}<br><small>${escape(item.email || item.method)}</small></td>
      <td><small>${escape(date(item.joinedAt))}</small></td><td>${badge(item.license?.status || 'Pending approval')}</td>
      <td><button class="action" type="button" data-manage="${escape(item.id)}">Manage</button></td></tr>`).join('')}
    </tbody></table></div>`;
}
function admin() {
  return `<div class="page-header"><div><h1>Customers</h1><p class="muted">Review registrations, approve payments and manage Premium keys.</p></div></div>
    <div class="card stack"><div class="table-tools"><label>Find a customer<input type="search" id="filter"
      placeholder="Name, email, Discord ID or status" value="${escape(lookup)}"></label><small id="customer-count">${customers.length} registered</small>
      <button type="button" class="action" id="refresh-customers">Refresh</button></div><div id="customer-list">${adminRows()}</div></div>`;
}
function manage(customerId) {
  const customer = customers.find(item => item.id === customerId);
  if (!customer) return;
  const licence = customer.license;
  const issue = !licence || ['Revoked','Expired'].includes(licence.status);
  showDialog(customer.name, `<p class="muted">${escape(customer.email || customer.method)} · ${escape(licence?.status || 'Pending approval')}</p>
    <section class="stack account-access">
      <h3>Account access</h3>
      <dl class="metric-list">
        ${metric(customer.discordId ? 'Discord ID' : 'Email',customer.discordId || customer.email)}
        ${metric('Personal PIN',customer.pinConfigured ? 'Configured' : 'Setup pending')}
      </dl>
      <div class="actions"><button type="button" class="action" id="recover-account">Generate recovery code</button></div>
    </section>
    ${licence?`<dl class="metric-list">
      ${metric('Key ending',licence.suffix)}${metric('Duration',duration(licence.duration))}
      ${metric('Device',licence.device?.code || 'Unlinked')}${metric('Last verified',date(licence.device?.lastSeen))}</dl>`:''}
    <form id="manage-form" class="stack">
      <div class="select-line"><label>Duration<select name="term">
        <option value="lifetime" ${!licence?.duration?'selected':''}>Lifetime</option>
        <option value="days" ${licence?.duration?'selected':''}>Set days</option>
      </select></label><label id="days-field">Days<input type="number" name="days" min="1" max="3650" value="${licence?.duration || 30}"></label></div>
      ${issue?'<label class="check"><input name="paymentConfirmed" type="checkbox" required> I have verified payment</label>':''}
      <p class="error" role="alert"></p>
      <div class="actions"><button type="submit" class="action primary">${issue?'Generate key':'Update duration'}</button>
        ${licence&&!licence.status.startsWith('Revoked')?'<button type="button" class="action danger" id="revoke-key">Revoke key</button>':''}
        ${licence?.device&&licence.status!=='Revoked'?'<button type="button" class="action" id="reset-device">Reset device</button>':''}</div>
    </form>
    <div class="stack"><h3>Recent activity</h3>${activity(customer.events)}</div>`);
  const form = dialog.querySelector('#manage-form');
  const term = form.elements.term;
  const toggleDays = () => { dialog.querySelector('#days-field').hidden = term.value!=='days'; };
  term.onchange = toggleDays;
  toggleDays();
  formHandler(form, async values => {
    const body = { customerId, action:issue?'issue':'duration',
      duration:values.term==='days'?Number(values.days):null, paymentConfirmed:values.paymentConfirmed==='on' };
    const result = await api('/api/admin/action',body);
    await refresh();
    if (issue) showKey('Portal key',result.code,'Share this one-time key privately with this customer. It unlocks the download after they redeem it.');
    else { manage(customerId); notify('Duration updated.'); }
  });
  for (const [selector, action, question] of [
    ['#revoke-key','revoke','Revoke this key and remove Premium download access?'],
    ['#reset-device','reset','Release the linked PC so the customer can activate another one?'],
    ['#recover-account','recover','Generate a recovery code for this account? Any previously issued recovery code will expire.']
  ]) {
    const button=dialog.querySelector(selector);
    if (!button) continue;
    button.onclick = async () => {
      if (!window.confirm(question)) return;
      button.disabled = true;
      try {
        const result = await api('/api/admin/action',{ customerId,action });
        await refresh();
        if (action === 'recover') {
          showKey('Account recovery code',result.code,'Verify the customer’s identity and share this code in their private ticket. It expires in 15 minutes and can be used once.','Recovery code');
        } else {
          manage(customerId);
          notify(action==='revoke'?'Key revoked.':'Device reset.');
        }
      }
      catch (error) { form.querySelector('.error').textContent=error.message; }
      finally { button.disabled = false; }
    };
  }
}

function render() {
  if (!state.account) { renderAuth(); return; }
  const isAdmin = state.account.role === 'admin';
  const tabs = isAdmin ? ['Customers','Downloads'] : ['Overview','Downloads','Devices','Activity','Support'];
  if (!tabs.includes(page)) page = tabs[0];
  const views = {
    Overview:overview, Devices:devices, Customers:admin,
    Downloads:() => '<div class="page-header"><h1>Downloads</h1></div>' + (isAdmin ?
      '<div class="card stack"><h2>Premium build</h2><p>Infrastructure status: ' +
      (state.release.available?'Ready · version '+escape(state.release.version)+' · '+size(state.release.size):'ZIP not configured') + '</p></div>' : download()),
    Activity:() => '<div class="page-header"><h1>License activity</h1></div><div class="card">' + activity(state.activity) + '</div>',
    Support:() => '<div class="page-header"><h1>Support</h1></div><div class="card stack"><h2>Purchase and device support</h2><p class="muted">Open a private ticket for payment verification, activation help or a device reset.</p><div class="actions"><a class="button" target="_blank" rel="noopener noreferrer" href="' + escape(state.supportUrl) + '">Open Discord</a></div></div>'
  };
  app.innerHTML = `<div class="frame"><aside class="rail">${brand}
    <nav aria-label="Portal">${tabs.map(tab=>`<button type="button" class="navitem" data-page="${tab}" ${tab===page?'aria-current="page"':''}>${tab}</button>`).join('')}</nav>
    <div class="rail-footer"><small>${escape(state.account.name)}${isAdmin?' · Admin':''}</small><button type="button" class="link-button" id="logout">Sign out</button></div>
    </aside><main class="workspace">${views[page]()}</main></div>`;
  app.querySelectorAll('[data-page]').forEach(button => button.onclick = () => {
    page = button.dataset.page; render(); window.scrollTo(0,0);
  });
  document.querySelector('#logout').onclick = async () => {
    try { await api('/api/logout',{}); resetAuth(); page='Overview'; await refresh(); }
    catch (error) { notify(error.message); }
  };
  formHandler(document.querySelector('#redeem'), async values => {
    await api('/api/redeem',values); await refresh(); notify('Premium download unlocked.');
  });
  formHandler(document.querySelector('#device'), async values => {
    const result = await api('/api/device',values); await refresh();
    showKey('Desktop activation key',result.key,'Copy this key into NovaMacro Premium to activate your Windows PC.');
  });
  if (isAdmin && page === 'Customers') {
    const filter = document.querySelector('#filter');
    const list = document.querySelector('#customer-list');
    list.addEventListener('click', event => {
      const button=event.target.closest('[data-manage]');
      if (button) manage(button.dataset.manage);
    });
    filter.oninput = () => { lookup=filter.value; list.innerHTML=adminRows(); };
    document.querySelector('#refresh-customers').onclick = () => refresh().catch(error=>notify(error.message));
  }
}

refresh().catch(error => { app.innerHTML = '<p class="loading">' + escape(error.message) + '</p>'; });
setInterval(async () => {
  if (!state?.account || document.hidden || dialog.open) return;
  const accountId = state.account.id;
  try {
    if (state.account.role === 'admin' && page === 'Customers') {
      const incoming = await api('/api/admin/customers');
      if (accountId !== state.account?.id || page !== 'Customers' || dialog.open) return;
      customers = incoming.customers;
      document.querySelector('#customer-list').innerHTML = adminRows();
      document.querySelector('#customer-count').textContent = customers.length + ' registered';
    } else if (state.account.role === 'customer' && !document.activeElement.matches('input,textarea,select')) {
      const incoming = await api('/api/state');
      if (accountId !== state.account?.id || dialog.open || document.activeElement.matches('input,textarea,select')) return;
      if (incoming.account?.id !== accountId || JSON.stringify(incoming.license) !== JSON.stringify(state.license) ||
          incoming.release.available !== state.release.available) {
        state = incoming;
        render();
      }
    }
  } catch {
    // Keep the current page usable while the connection recovers.
  }
}, 15000);
