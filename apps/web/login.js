const form = document.querySelector('#login-form');
const button = form.querySelector('button');
const error = document.querySelector('#login-error');
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled) return;
  button.disabled = true;
  error.textContent = '';
  try {
    const response = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '登录失败，请稍后重试。');
    window.location.replace('/');
  } catch (cause) {
    error.textContent = cause.message === 'Failed to fetch' ? '无法连接，请检查网络后重试。' : cause.message;
    form.elements.password.value = '';
  } finally { button.disabled = false; }
});
