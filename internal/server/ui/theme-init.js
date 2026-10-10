try {
  var t = localStorage.getItem("ms-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {
  /* storage unavailable: keep the default theme */
}
