// Runner for captcha/turnstile. Loads Cloudflare's script on first use, then
// renders (or, on retry, resets) the widget with cData = the link's binding.
window.bouncerRunners['captcha/turnstile'] = function (el, cfg, done, fail) {
  function render() {
    if (el.dataset.widgetId) { window.turnstile.reset(el.dataset.widgetId); return; }
    el.dataset.widgetId = window.turnstile.render(el, {
      sitekey: cfg.sitekey,
      cData: cfg.binding,
      callback: function (token) { done({ token: token }); },
      'error-callback': fail
    });
  }
  if (window.turnstile) return render();
  var s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.async = true;
  s.onload = render;
  s.onerror = fail;
  document.head.appendChild(s);
};
