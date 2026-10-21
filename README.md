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

Hiçbir Amazon sekmesi açılmaz. Düğme tıklanınca izin istenir, servis çalışanı kimlik bilgileri olmadan kanonik URL'ye `fetch` yapar, HTML uzantının görünmeyen offscreen belgesindeki `DOMParser` ile incelenir. Bu belge **canlı bir Amazon sayfasını açıp çalıştırmaz**; Amazon'un istemci tarafında sonradan oluşturduğu fiyatları görmeyebilir.

## Desteklenen bağlantılar

- `https://www.amazon.com.tr/dp/ASIN`
- `https://www.amazon.com.tr/gp/product/ASIN`
- `https://www.amazon.com.tr/Urun-Basligi/dp/ASIN` (Türkçe karakter içeren yüzde kodlu başlıklar dahil)
- Bu ürün yollarının sonundaki `/ref=...` yönlendirme parçaları ve sorgu parametreleri
- `https://amzn.eu/d/KisaKod` paylaşım bağlantısı

Ürün yolu ve ASIN belirlendikten sonra başlık, sorgu parametreleri ve izleme bilgileri atılır; fiyat kontrolü her zaman temiz `https://www.amazon.com.tr/dp/ASIN` adresine yapılır. Başka Amazon pazar yerleri, benzer görünen alan adları, serbest biçimli yollar ve sorgu metninden ASIN çıkarımı kabul edilmez.

Kısa bağlantı, uzantı servis çalışanında `redirect: "manual"` ve kimlik bilgisi olmadan çözülmeye çalışılır. Her görünür `Location` bir sonraki isteğe geçmeden önce HTTPS, kimlik bilgisi/port yokluğu ve tam alan adı açısından denetlenir. Yalnızca aynı `amzn.eu` kısa bağlantı biçimine veya geçerli Amazon Türkiye ürün URL'sine devam edilir. Amazon Türkiye dışındaki Amazon pazar yerleri reddedilir; diğer alan adlarına istek yapılmaz. Yönlendirme döngüsü ve beşten fazla yönlendirme reddedilir. Fetch API yönlendirme hedefini `opaqueredirect` olarak gizlerse çözümleme güvenli biçimde başarısız olur; bu durumda prototip kısa linki çözemeyebilir. Kısa bağlantı yönlendirmesi gerçek tarayıcıda henüz doğrulanmadı.

## Fiyat ve sınırlar

21 Ekim 2026'da ürün sayfasında elle çalıştırılan `document.querySelector("#corePrice_feature_div .a-offscreen")?.textContent?.trim()` ifadesi `36.399,00TL` sonucunu verdi. Bu, **açık canlı sayfanın DOM'u** üzerindeki gözlemdir. 36.399,00 TL sabit bir beklenen fiyat değildir. Uzantının **arka planda alınan HTML** ile çalışacağı Chrome veya Comet üzerinde henüz doğrulanmadı.

Yalnızca `#corePrice_feature_div .a-offscreen` içindeki tek, TL biçimindeki fiyat kabul edilir. Reklam, öneri, eski fiyat veya taksit tutarına geçilmez. Fiyat bulunamazsa veya Amazon robot doğrulaması, erişim engeli, oturum açma, HTTP hatası, yönlendirme ya da ağ hatası dönerse sorgu başarısız kaydedilir. Başarısız sonuç eski başarılı fiyatı değiştirmez. Giriş yapılmış tarayıcı oturumunun çerezleri gönderilmez; dolayısıyla kullanıcıya özel fiyatlar görülemeyebilir. CAPTCHA aşma veya görünür sekme çözümü yoktur.

Manifest `storage`, `offscreen` ve iki isteğe bağlı site erişimi içerir: `https://www.amazon.com.tr/*` ve `https://amzn.eu/*`. Normal ürün URL'si yalnızca Amazon Türkiye iznini ister; `amzn.eu` izni yalnızca kısa bağlantı girildiğinde istenir. Tarama geçmişi, çerez API'si, diğer siteler, uzak kod, sunucu hesabı veya telemetri kullanılmaz. HTML saklanmaz; yalnızca son sorgunun ASIN/bağlantısı, kanonik URL (belirlenebildiyse), durum, zaman ve gerekliyse fiyat veya güvenli hata kodu saklanır.

## Uzun ve kısa bağlantıları elle deneme

1. Bu uzun bağlantıyı yapıştırın: `https://www.amazon.com.tr/Soundcore-Kablosuz-Kulakl%C4%B1k-G%C3%BCr%C3%BClt%C3%BCs%C3%BCne-Bluetooth/dp/B0CQXKXBR7?pd_rd_w=example&ref_=example`. Popup bunu `https://www.amazon.com.tr/dp/B0CQXKXBR7` biçimine getirip fiyatı kontrol etmelidir.
2. `https://amzn.eu/d/02JpD8hn` gibi bir paylaşım bağlantısı girin. Amazon Türkiye ve `amzn.eu` izinlerini onaylayın; çözümleme tamamlandığında popup alanı temiz ürün URL'sine dönüşmelidir. Güvenli şekilde çözümlenemeyen yönlendirme açık hata verir.
3. `https://www.amazon.de/dp/B0CQXKXBR7` ile desteklenmeyen pazar yeri mesajını; `https://evil.example/dp/B0CQXKXBR7` ile geçersiz bağlantı mesajını doğrulayın.

Chrome veya Comet Fetch API'si elle yönlendirme yanıtının `Location` başlığını sunmazsa kısa bağlantı desteği o tarayıcıda çalışmaz. Güvenlik nedeniyle otomatik yönlendirmeli fetch veya görünür sekme yedeği kullanılmaz.

## Testler

Node.js 20+ ile depo kökünde `npm test` çalıştırın. Harici paket kurulumu gerekmez. Testler sentetik HTML örnekleri ve DOM'un test uyarlaması ile fiyat seçme mantığını dener; gerçek Amazon ağına bağlanmaz. Gerçek tarayıcıda manifest yüklenmesi, offscreen DOMParser ve ağ yanıtı ayrıca elle doğrulanmalıdır.
