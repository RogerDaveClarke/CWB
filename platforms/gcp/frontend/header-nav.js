function renderIcon(name) {
    const icon = document.createElement("i");
    icon.dataset.lucide = name;
    icon.className = "h-4 w-4";
    return icon;
}

export function setHeaderUser(button, user) {
    if (!button) return;
    const signedIn = Boolean(user);
    const name = user?.displayName || user?.email || "Sign out";
    const label = signedIn ? `Sign out ${name}` : "Sign in";
    const text = document.createElement("span");
    text.className = "header-user-name";
    text.textContent = signedIn ? name : "Sign in";
    button.replaceChildren(renderIcon(signedIn ? "log-out" : "log-in"), text);
    button.title = label;
    button.setAttribute("aria-label", label);
    if (window.lucide) window.lucide.createIcons();
}

export function initHeaderControls() {
    const clock = document.getElementById("headerClock");
    if (clock) {
        const updateClock = () => {
            clock.textContent = new Intl.DateTimeFormat("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit"
            }).format(new Date());
        };
        updateClock();
        setInterval(updateClock, 1000);
    }

    const fullscreen = document.getElementById("fullscreenToggle");
    fullscreen?.addEventListener("click", async () => {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
    });
}