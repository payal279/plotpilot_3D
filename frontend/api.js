// All backend calls live here, so the UI code stays clean.
const API_BASE = 'http://127.0.0.1:8000';

// ---------- auth helpers ----------
function getToken() {
  return localStorage.getItem('pp_token');
}

function getUser() {
  try { return JSON.parse(localStorage.getItem('pp_user') || '{}'); } catch (e) { return {}; }
}

function logout() {
  localStorage.removeItem('pp_token');
  localStorage.removeItem('pp_user');
  location.href = 'index.html';
}

// Call at the top of pages that need a logged-in user.
function requireLogin() {
  if (!getToken()) { location.replace('login.html'); return false; }
  return true;
}

// ---------- one function for every request ----------
// Always returns { ok:true, data } or { ok:false, error }.
async function request(method, path, body) {
  try {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      if (res.status === 401 && token) { logout(); return { ok: false, error: 'Session expired.' }; }
      let msg = 'Something went wrong.';
      if (typeof data.detail === 'string') msg = data.detail;
      else if (Array.isArray(data.detail)) msg = 'Please check the details you entered.';
      return { ok: false, error: msg };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: 'Cannot reach the server. Is the backend running?' };
  }
}

// ---------- auth ----------
function signupUser(name, email, password) {
  return request('POST', '/api/signup', { name, email, password });
}

function loginUser(email, password) {
  return request('POST', '/api/login', { email, password });
}

// ---------- design generation ----------
// data: { parsed, plot, margins, autofix, checks, metrics, cost, variants: [...] }
function generatePlan(prompt) {
  return request('POST', '/api/generate', { prompt });
}

// ---------- saved designs ----------
function listProjects() {
  return request('GET', '/api/projects');
}

function saveProject(prompt, title) {
  return request('POST', '/api/projects', { prompt, title: title || '' });
}

function deleteProject(id) {
  return request('DELETE', '/api/projects/' + encodeURIComponent(id));
}

// ---------- landing page: navbar + call-to-action change when logged in ----------
document.addEventListener('DOMContentLoaded', function () {
  const loggedIn = !!getToken();

  const nav = document.getElementById('nav-auth');
  if (nav && loggedIn) {
    nav.textContent = (getUser().name || 'Account') + ' / ';
    const a = document.createElement('a');
    a.href = '#';
    a.textContent = 'Log out';
    a.onclick = function (e) { e.preventDefault(); logout(); };
    nav.appendChild(a);
  }

  const cta = document.getElementById('cta');
  if (cta && loggedIn) {
    cta.textContent = '';
    const b = document.createElement('a');
    b.className = 'btn';
    b.href = 'app.html';
    b.textContent = 'Open workspace';
    cta.appendChild(b);
  }
});
