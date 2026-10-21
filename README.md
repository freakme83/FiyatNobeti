# FiyatNöbeti

Amazon Türkiye ürün bağlantısı için **yalnızca elle başlatılan** fiyat sorgusunun deneysel Chrome Manifest V3 prototipi. Çoklu ürün takibi, zamanlanmış kontroller ve bildirimler bu sürümde yoktur.

## Yükleme

**Chrome:** Depoyu bilgisayarınıza indirin veya klonlayın. `chrome://extensions` adresinde Geliştirici modu'nu açın, **Paketlenmemiş öğe yükle** seçeneğini kullanın ve `manifest.json` dosyasının bulunduğu depo klasörünü seçin. Chrome 116 veya üstü önerilir.

**Perplexity Comet:** Comet'in Chromium uzantı yönetimi ekranı paketlenmemiş uzantı yüklemeyi sunuyorsa geliştirici modunu açıp aynı depo klasörünü seçin. Comet'in bu API'leri desteklediği henüz doğrulanmadı; yükleme seçeneği veya `chrome.offscreen` yoksa prototip orada çalışmayabilir.

## Elle fiyat sorgusu

1. Uzantı simgesine tıklayın. Örnek olarak `https://www.amazon.com.tr/dp/B0FZ9Y4GPF` bağlantısını girin.
2. **Fiyatı kontrol et** düğmesine basın. İlk sorguda yalnızca `https://www.amazon.com.tr/*` için site erişimini onaylayın.
3. Açılır pencerede fiyatı veya hata nedenini, ASIN'i ve kontrol zamanını inceleyin. `chrome://extensions` sayfasındaki uzantının **Service worker** bağlantısından teknik hataları görebilirsiniz. Son kontrol ve son başarılı kontrol ayrıca `chrome.storage.local` içinde tutulur; önceki başarılı fiyat “güncel değil” olarak gösterilir.
4. Comet'te yükleme mümkünse aynı işlemleri uzantı simgesinden deneyin ve uzantı hata ekranını kontrol edin.

Hiçbir Amazon sekmesi açılmaz. Düğme tıklanınca izin istenir, servis çalışanı kimlik bilgileri olmadan kanonik URL'ye `fetch` yapar, HTML uzantının görünmeyen offscreen belgesindeki `DOMParser` ile incelenir. Bu belge **canlı bir Amazon sayfasını açıp çalıştırmaz**; Amazon'un istemci tarafında sonradan oluşturduğu fiyatları görmeyebilir. Yönlendirmeler takip edilmez.

## Fiyat ve sınırlar

21 Ekim 2026'da ürün sayfasında elle çalıştırılan `document.querySelector("#corePrice_feature_div .a-offscreen")?.textContent?.trim()` ifadesi `36.399,00TL` sonucunu verdi. Bu, **açık canlı sayfanın DOM'u** üzerindeki gözlemdir. 36.399,00 TL sabit bir beklenen fiyat değildir. Uzantının **arka planda alınan HTML** ile çalışacağı Chrome veya Comet üzerinde henüz doğrulanmadı.

Yalnızca `#corePrice_feature_div .a-offscreen` içindeki tek, TL biçimindeki fiyat kabul edilir. Reklam, öneri, eski fiyat veya taksit tutarına geçilmez. Fiyat bulunamazsa veya Amazon robot doğrulaması, erişim engeli, oturum açma, HTTP hatası, yönlendirme ya da ağ hatası dönerse sorgu başarısız kaydedilir. Başarısız sonuç eski başarılı fiyatı değiştirmez. Giriş yapılmış tarayıcı oturumunun çerezleri gönderilmez; dolayısıyla kullanıcıya özel fiyatlar görülemeyebilir. CAPTCHA aşma veya görünür sekme çözümü yoktur.

Manifest yalnızca `storage`, `offscreen` ve isteğe bağlı `https://www.amazon.com.tr/*` erişimi içerir. Tarama geçmişi, çerez API'si, diğer siteler, uzak kod, sunucu hesabı veya telemetri kullanılmaz. HTML saklanmaz; yalnızca son sorgunun ASIN, kanonik URL, durum, zaman ve gerekliyse fiyat veya güvenli hata kodu saklanır.

## Testler

Node.js 20+ ile depo kökünde `npm test` çalıştırın. Harici paket kurulumu gerekmez. Testler sentetik HTML örnekleri ve DOM'un test uyarlaması ile fiyat seçme mantığını dener; gerçek Amazon ağına bağlanmaz. Gerçek tarayıcıda manifest yüklenmesi, offscreen DOMParser ve ağ yanıtı ayrıca elle doğrulanmalıdır.
