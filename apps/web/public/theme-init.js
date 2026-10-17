// Applies the saved theme before the app starts, so the page does not flash the wrong colours.
// It is an external file because the server's Content-Security-Policy forbids inline scripts.
try {
  var savedTheme = localStorage.getItem('ms-theme');
  if (savedTheme === 'light' || savedTheme === 'dark') document.documentElement.dataset.theme = savedTheme;
} catch (storageError) {
  /* storage unavailable: keep the default theme */
}
