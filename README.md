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

Kısa bağlantı çözümleme denemesi artık `redirect: "follow"` kullanır; Chrome yönlendirmeleri Fetch içinde izler ve resolver yalnızca tamamlanan yanıtın `response.url` değerini inceler. Son yanıt başarılı değilse veya son URL alınamıyor, HTTPS kullanmıyor, tam olarak `www.amazon.com.tr` alan adına ait değil ya da desteklenen bir ürün yolu içermiyorsa fiyat sorgusuna geçilmez. Başarılı bir son URL mevcut normalleştiriciyle temiz `/dp/ASIN` adresine çevrilir.

**Güvenlik sınırı:** `follow` sırasında ara yönlendirmeler uzantı kodu URL'leri denetleyemeden izlenir. Son URL'nin denetlenmesi, yönlendirme zincirindeki ara isteklerin başka bir alana gitmesini engellemez. Bu nedenle yalnızca Amazon uygulamasından veya sitesinden kendiniz kopyaladığınız ve güvendiğiniz ürün bağlantılarını kullanın. Popup bu kısa uyarıyı yalnızca geçerli bir `amzn.eu` bağlantısı girildiğinde gösterir; bağlantının güvenli olduğunu doğruladığı anlamına gelmez. Kimlik bilgileri hâlâ `omit` ile gönderilmez; oturum gerektiren yönlendirmeler/ürünler başarısız olabilir. Tarayıcı Fetch/CORS kuralları da ağ hatasına yol açabilir. Kısa bağlantı çözümleme Chrome ve Comet'te gerçek tarayıcı testi bekleyen deneysel bir özelliktir.

## Fiyat ve sınırlar

21 Ekim 2026'da ürün sayfasında elle çalıştırılan `document.querySelector("#corePrice_feature_div .a-offscreen")?.textContent?.trim()` ifadesi `36.399,00TL` sonucunu verdi. Bu, **açık canlı sayfanın DOM'u** üzerindeki gözlemdir. 36.399,00 TL sabit bir beklenen fiyat değildir. Uzantının **arka planda alınan HTML** ile çalışacağı Chrome veya Comet üzerinde henüz doğrulanmadı.

Yalnızca `#corePrice_feature_div .a-offscreen` içindeki satış fiyatı adayı kabul edilir. Adayın üst DOM öğelerinden birinde `apex-priceperuni` ile başlayan ayrı bir sınıf token'ı varsa bu bilinen birim fiyatı bileşeni dışarıda bırakılır; birim fiyatı asla ürün satış fiyatı olarak kullanılmaz. Birden fazla satış fiyatı adayı kalırsa sonuç yine belirsiz sayılır. Reklam, öneri, eski fiyat veya taksit tutarına geçilmez. Fiyat bulunamazsa veya Amazon robot doğrulaması, erişim engeli, oturum açma, HTTP hatası, yönlendirme ya da ağ hatası dönerse sorgu başarısız kaydedilir. Başarısız sonuç eski başarılı fiyatı değiştirmez. Giriş yapılmış tarayıcı oturumunun çerezleri gönderilmez; dolayısıyla kullanıcıya özel fiyatlar görülemeyebilir. CAPTCHA aşma veya görünür sekme çözümü yoktur.

Manifest `storage`, `offscreen` ve iki isteğe bağlı site erişimi içerir: `https://www.amazon.com.tr/*` ve `https://amzn.eu/*`. Normal ürün URL'si yalnızca Amazon Türkiye iznini ister; `amzn.eu` izni yalnızca kısa bağlantı girildiğinde istenir. Tarama geçmişi, çerez API'si, diğer siteler, uzak kod, sunucu hesabı veya telemetri kullanılmaz. HTML saklanmaz; yalnızca son sorgunun ASIN/bağlantısı, kanonik URL (belirlenebildiyse), durum, zaman ve gerekliyse fiyat veya güvenli hata kodu saklanır.

## Uzun ve kısa bağlantıları elle deneme

1. Bu uzun bağlantıyı yapıştırın: `https://www.amazon.com.tr/Soundcore-Kablosuz-Kulakl%C4%B1k-G%C3%BCr%C3%BClt%C3%BCs%C3%BCne-Bluetooth/dp/B0CQXKXBR7?pd_rd_w=example&ref_=example`. Popup bunu `https://www.amazon.com.tr/dp/B0CQXKXBR7` biçimine getirip fiyatı kontrol etmelidir.
2. Kendinizin Amazon'dan kopyaladığı `https://amzn.eu/d/02JpD8hn` bağlantısını girin. İstenirse Amazon Türkiye ve `amzn.eu` izinlerini verin. Popup çözümleme sırasında kısa durum mesajını ve güvenlik notunu gösterir; başarıda alanı temiz ürün URL'sine çevirip mevcut fiyat kontrolüne devam eder.
3. `https://www.amazon.de/dp/B0CQXKXBR7` ile desteklenmeyen pazar yeri mesajını; `https://evil.example/dp/B0CQXKXBR7` ile geçersiz bağlantı mesajını doğrulayın.

Chrome'da test etmek için `chrome://extensions` sayfasında uzantıyı yeniden yükleyin, popup'ta kendinizin Amazon'dan kopyaladığı kısa bağlantıyı yapıştırın ve **Fiyatı kontrol et** düğmesine basın. Normal Amazon URL'leriyle kontrolü de tekrarlayın; bu akışta `amzn.eu` izni istenmemelidir. Comet'te aynı test, yalnızca paketlenmemiş uzantı yükleme ve gerekli MV3 API'leri varsa yapılabilir. Bu yaklaşımda görünür Amazon sekmesi açılmaz.

### Kısa bağlantı hata tanıları

`amzn.eu` isteği başarısız olursa son kontrol kaydında hata kodu, zaman ve yanıt mevcut kıldıysa HTTP durumu ile Fetch yanıt türü tutulur. `follow` kipinde ara yönlendirme sayısı ve `Location` başlığı uzantı tarafından okunamaz; bunlar raporlanmaz. Son URL, yanıt gövdesi, çerez, kimlik bilgisi, başlıklar veya ham hata/stack saklanmaz. Popup kullanıcıya Türkçe açıklama, kod ve güvenli metadata'yı gösterir. Önceki başarılı fiyat ayrı tutulur ve başarısız deneme onu güncellemez.

Tanı kodları: `SHORT_LINK_OPAQUE_REDIRECT`, `SHORT_LINK_OPAQUE_RESPONSE`, `SHORT_LINK_HTTP_STATUS`, `SHORT_LINK_NETWORK_ERROR`, `SHORT_LINK_TIMEOUT`, `SHORT_LINK_FINAL_URL_MISSING`, `SHORT_LINK_FINAL_URL_INVALID`, `SHORT_LINK_UNSAFE_REDIRECT`, `SHORT_LINK_UNSUPPORTED_MARKETPLACE` ve `SHORT_LINK_UNSUPPORTED_PRODUCT_URL`. Beklenmeyen hatalar `SHORT_LINK_RESOLUTION_FAILED` ile gösterilir. İzin reddi `SHORT_LINK_PERMISSION_REQUIRED` olarak kaydedilir. Fetch, ağ/CORS hatası ile tarayıcının yönlendirme sınırı gibi bazı nedenleri birbirinden ayıran bilgi sunmayabilir; bu durumda genel `SHORT_LINK_NETWORK_ERROR` kullanılır.

Bilinen gerçek tarayıcı sonucu: `https://amzn.eu/d/02JpD8hn` için manuel yönlendirme kipinde Chrome `SHORT_LINK_OPAQUE_REDIRECT` döndürdü (`opaqueredirect`, sıfır okunabilir yönlendirme, Location erişilemez). Bu deneme otomatik yönlendirme kipini test etmez. Yeni akışın gerçek Chrome/Comet davranışı henüz doğrulanmamıştır.

Chrome'da kısa bağlantıyı yeniden denemek için uzantıyı yükleyin/yenileyin, güvenlik notunu gördükten sonra Amazon uygulamasından veya sitesinden kendiniz kopyaladığınız `amzn.eu` ürün linkini girin ve **Fiyatı kontrol et** düğmesine basın. Popup'taki hata kodunu ve gösterilen HTTP/yanıt türü metadata'sını, ayrıca Chrome sürümünü not edin. Yalnızca bu güvenli tanı değerlerini bildirin; URL'yi veya ara yönlendirme bilgilerini paylaşmanız gerekmez. Yerel sonuç `chrome.storage.local` içindeki `lastCheck` anahtarındadır.

Otomatik testler yalnızca sahte Fetch yanıtları kullanır. Gerçek Chrome veya Comet'in yönlendirme takibini, CORS izinlerini ya da son URL raporlamasını doğrulamaz; kısa bağlantı desteği gerçek tarayıcı testi tamamlanana kadar deneysel kalır.

## Testler

Node.js 20+ ile depo kökünde `npm test` çalıştırın. Harici paket kurulumu gerekmez. Testler sentetik HTML örnekleri ve DOM'un test uyarlaması ile fiyat seçme mantığını dener; gerçek Amazon ağına bağlanmaz. Gerçek tarayıcıda manifest yüklenmesi, offscreen DOMParser ve ağ yanıtı ayrıca elle doğrulanmalıdır.
