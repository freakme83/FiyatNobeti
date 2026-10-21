import { AMAZON_PERMISSION_ORIGIN, AMAZON_SHORT_LINK_PERMISSION_ORIGIN, REQUIRED_AMAZON_ORIGINS, getMissingAmazonOrigins } from "./popup-permissions.js";

export { AMAZON_PERMISSION_ORIGIN, AMAZON_SHORT_LINK_PERMISSION_ORIGIN };

export function createPermissionOnboarding({
  permissions,
  loadingView,
  onboardingView,
  normalView,
  permissionButton,
  explanation,
  status,
  onAuthorized = () => {},
}) {
  let requestPending = false;
  let normalStarted = false;
  let missingOrigins = [...REQUIRED_AMAZON_ORIGINS];

  function showOnboarding(message = "") {
    loadingView.hidden = true;
    normalView.hidden = true;
    onboardingView.hidden = false;
    if (explanation) {
      explanation.textContent = missingOrigins.includes(AMAZON_PERMISSION_ORIGIN)
        ? "Amazon Türkiye ürünlerini ve kısa paylaşım bağlantılarını takip edebilmek için Amazon erişim izni gerekiyor."
        : "Kısa paylaşım bağlantılarını kullanabilmek için amzn.eu erişimini etkinleştirin.";
    }
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
      missingOrigins = await getMissingAmazonOrigins(permissions);
      if (missingOrigins.length === 0) showNormal();
      else showOnboarding();
    } catch {
      missingOrigins = [...REQUIRED_AMAZON_ORIGINS];
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
      const requested = await permissions.request({ origins: [...missingOrigins] });
      missingOrigins = await getMissingAmazonOrigins(permissions);
      if (missingOrigins.length === 0) {
        showNormal();
      } else if (requested === false) {
        showOnboarding("İzin verilmedi. İzin vermek için bu düğmeyi yeniden deneyebilirsiniz.");
      } else {
        showOnboarding("Bazı izinler eksik kaldı. Yeniden deneyebilirsiniz.");
      }
    } catch {
      try {
        missingOrigins = await getMissingAmazonOrigins(permissions);
        if (missingOrigins.length === 0) showNormal();
        else showOnboarding("İzin isteği tamamlanamadı. Yeniden deneyebilirsiniz.");
      } catch {
        missingOrigins = [...REQUIRED_AMAZON_ORIGINS];
        showOnboarding("İzin isteği tamamlanamadı. Yeniden deneyebilirsiniz.");
      }
    } finally {
      requestPending = false;
      permissionButton.disabled = false;
    }
  });

  return { start };
}
