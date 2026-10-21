export const AMAZON_PERMISSION_ORIGIN = "https://www.amazon.com.tr/*";

export function createPermissionOnboarding({
  permissions,
  loadingView,
  onboardingView,
  normalView,
  permissionButton,
  status,
  onAuthorized = () => {},
}) {
  let requestPending = false;
  let normalStarted = false;

  function showOnboarding(message = "") {
    loadingView.hidden = true;
    normalView.hidden = true;
    onboardingView.hidden = false;
    status.textContent = message;
  }

  function showNormal() {
    loadingView.hidden = true;
    onboardingView.hidden = true;
    normalView.hidden = false;
    status.textContent = "";
    if (!normalStarted) {
      normalStarted = true;
      onAuthorized();
    }
  }

  async function start() {
    try {
      const permitted = await permissions.contains({ origins: [AMAZON_PERMISSION_ORIGIN] });
      if (permitted === true) showNormal();
      else showOnboarding();
    } catch {
      showOnboarding("İzin durumu kontrol edilemedi. Yeniden deneyebilirsiniz.");
    }
  }

  permissionButton.addEventListener("click", async () => {
    if (requestPending) return;
    requestPending = true;
    permissionButton.disabled = true;
    status.textContent = "";

    try {
      // This API call is made synchronously from the explicit button gesture.
      const requested = await permissions.request({ origins: [AMAZON_PERMISSION_ORIGIN] });
      const currentlyPermitted = await permissions.contains({ origins: [AMAZON_PERMISSION_ORIGIN] });
      if (requested === true && currentlyPermitted === true) {
        showNormal();
      } else if (currentlyPermitted === true) {
        showNormal();
      } else {
        showOnboarding("İzin verilmedi. İzin vermek için bu düğmeyi yeniden deneyebilirsiniz.");
      }
    } catch {
      showOnboarding("İzin isteği tamamlanamadı. Yeniden deneyebilirsiniz.");
    } finally {
      requestPending = false;
      permissionButton.disabled = false;
    }
  });

  return { start };
}
