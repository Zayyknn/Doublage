document.getElementById("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const err = document.getElementById("err");
  err.textContent = "";
  const res = await fetch("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: document.getElementById("pw").value }),
  });
  if (res.ok) location.href = "/";
  else err.textContent = "Mot de passe incorrect";
});
