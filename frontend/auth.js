(function () {
  const form = document.getElementById('auth-form');
  if (!form) return;

  // Already logged in? Go to the main page.
  if (getToken()) { location.replace('app.html'); return; }

  const mode = form.dataset.mode; // "login" or "signup"
  const msg = document.getElementById('auth-msg');
  const btn = form.querySelector('button[type="submit"]');

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    msg.textContent = '';

    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    let name = '';

    if (!email || !password) { msg.textContent = 'Please fill in all fields.'; return; }

    if (mode === 'signup') {
      name = document.getElementById('name').value.trim();
      const confirm = document.getElementById('confirm').value;
      if (!name) { msg.textContent = 'Please enter your name.'; return; }
      if (password.length < 8) { msg.textContent = 'Password must be at least 8 characters.'; return; }
      if (password !== confirm) { msg.textContent = 'Passwords do not match.'; return; }
    }

    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Please wait';

    const r = mode === 'signup' ? await signupUser(name, email, password) : await loginUser(email, password);

    btn.disabled = false;
    btn.textContent = label;

    if (!r.ok) { msg.textContent = r.error; return; }

    localStorage.setItem('pp_token', r.data.token);
    localStorage.setItem('pp_user', JSON.stringify(r.data.user));
    location.href = 'app.html';
  });
})();