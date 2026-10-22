# FiyatNöbeti

Amazon Türkiye ürünlerini yerel bir izleme listesine ekleyip fiyatlarını elle veya yaklaşık altı saatte bir kontrol eden deneysel Chrome Manifest V3 uzantısı. Bildirimler ve fiyat geçmişi bu sürümde yoktur.

## Yükleme

**Chrome:** Depoyu bilgisayarınıza indirin veya klonlayın. `chrome://extensions` adresinde Geliştirici modu'nu açın, **Paketlenmemiş öğe yükle** seçeneğini kullanın ve `manifest.json` dosyasının bulunduğu depo klasörünü seçin. Chrome 116 veya üstü önerilir.

**Perplexity Comet:** Comet'in Chromium uzantı yönetimi ekranı paketlenmemiş uzantı yüklemeyi sunuyorsa geliştirici modunu açıp aynı depo klasörünü seçin. Comet'in bu API'leri desteklediği henüz doğrulanmadı; yükleme seçeneği veya `chrome.offscreen` yoksa prototip orada çalışmayabilir.

## Testing without Node.js

For Windows testers who cannot install Node.js, use the ready-to-load GitHub Actions packages. No PowerShell, administrator permission, terminal, or local build command is needed to generate them.

1. Open this repository's **Actions** tab and select the latest successful **Build extension test packages** run for PR #6 (or its branch).
2. Download the `fiyatnobeti-developer` artifact. GitHub downloads artifacts in a wrapper ZIP; extract it, then extract the included `fiyatnobeti-developer.zip`.
3. Open `chrome://extensions`, enable **Developer mode**, and click **Load unpacked**.
4. Select the extracted developer package folder containing `manifest.json`.
5. Use FiyatNöbeti normally. For diagnostics, open the extension's service worker **Inspect** console and use the developer commands documented below.

The standard package is also available as the `fiyatnobeti-standard` artifact. Chrome cannot load an extension directly from a ZIP, so the package must be extracted first. Artifacts may require GitHub sign-in and are retained for 14 days. Developers can continue to generate a local package with `npm run dev:prepare`.

## Yerel izleme listesi

1. Amazon erişim izinlerinden biri eksikse popup önce karşılama/izin tamamlama ekranını gösterir. **Amazon erişimini etkinleştir** düğmesine basıp Chrome'un izin penceresini onaylayın. Bu tek tıklama, eksik olan `https://www.amazon.com.tr/*` ve `https://amzn.eu/*` izinlerini ister. Ürün bağlantısını ancak normal ekran açıldıktan sonra girin.
2. `/dp/ASIN`, `/gp/product/ASIN`, başlıklı/izleme parametreli ürün URL'leri ve `amzn.eu` kısa paylaşım bağlantıları desteklenir. **Ürün ekle** düğmesine basın. İki izin onboarding sırasında verildiyse iki bağlantı türü de ek bir izin istemi açmadan çalışır. İlk fiyat sorgusu başarısız olsa bile ürün listede kalır.
3. **Otomatik kontrol** varsayılan olarak açıktır. Popup'taki anahtarla kapatıp yeniden açabilirsiniz. Her ürünün **Fiyatı kontrol et** düğmesiyle istediğiniz zaman elle kontrol başlatabilirsiniz. Başarısız kontrol son başarılı fiyatı ve başlığı korur; fiyatı “güncel değil” olarak gösterir. **Listeden kaldır** yalnızca seçilen ürünü siler.
4. İzleme listesi popup kapanıp açılsa da `chrome.storage.local` içinde kalır. Aynı ASIN yeniden eklenirse yinelenen kayıt oluşturulmaz.
5. Comet'te yükleme mümkünse aynı işlemleri deneyin ve uzantı hata ekranını kontrol edin.

Hiçbir Amazon sekmesi açılmaz. Her iki site izni yalnızca karşılama ekranındaki açık düğmeyle, eksik origin'ler için istenir; izin verilmesi tek başına ürün sorgusu başlatmaz. Sadece Amazon Türkiye izni olan eski kurulumlarda normal arayüz açılmaz; eksik `amzn.eu` izni açıkça tamamlatılır. Popup'ta izinlerden biri eksik hale gelirse ürün gönderimi izin istemi açmak yerine onboarding'e döner ve girilmiş URL popup açık kaldığı sürece korunur. Servis çalışanı ürün eklendiğinde veya kontrol istendiğinde kimlik bilgileri olmadan kanonik URL'ye `fetch` yapar, HTML uzantının görünmeyen offscreen belgesindeki `DOMParser` ile incelenir. Bu belge **canlı bir Amazon sayfasını açıp çalıştırmaz**; Amazon'un istemci tarafında sonradan oluşturduğu fiyatları görmeyebilir.

### İlk açılış izni doğrulaması

Chrome'da uzantıyı temiz bir profilde yükleyip popup'ı açın: ürün formu yerine karşılama görünmelidir. İzin düğmesine basın ve iki origin'i onaylayın; Chrome popup'ı kapatırsa yeniden açınca normal liste görünmelidir. Sonra standart Amazon ürünü ve `amzn.eu` linki ekleyin; ikisi de ikinci izin istemi açmadan ilerlemelidir. Ayrıca yalnızca Amazon izni olan eski bir kurulumla açıp eksik `amzn.eu` erişiminin istendiğini, tek origin'in tamamlanabildiğini doğrulayın. İzin isteğini reddedip yeniden deneyin; Amazon izinlerinden birini `chrome://extensions` içinden kaldırıp tekrar açın ve ürünlerin korunduğunu kontrol edin. Comet'te aynı adımları, uzantı yönetimi ve izin API'leri destekleniyorsa uygulayın. Chrome'un native izin ekranı sırasında popup'ı kapatıp kapatmaması ve Comet davranışı gerçek tarayıcıda doğrulanmalıdır; otomatik testler bunları taklit eder.

### Yerel veri şeması

`chrome.storage.local` içindeki `watchlist` kaydı `{ version: 1, products: { [ASIN]: product } }` biçimindedir. Ürün kaydı kanonik URL, doğrulanmış başlık (varsa), son başarılı TRY fiyatı ve zamanı, son deneme zamanı, son kontrol durumu/hata kodu ve eklenme zamanını içerir. ASIN tekil anahtardır. Eski tek ürün prototipindeki son başarılı kayıt varsa ilk liste okumasında mevcut veriyi korumak için şemaya taşınır. Ürün HTML'i veya kısa link/izleme parametreleri saklanmaz.

Ürün başlığı aynı fiyat kontrolü için alınmış HTML'deki yalnızca `#productTitle` öğesinden okunur, boşlukları düzenlenir ve en fazla 200 karakter kabul edilir. Bulunamazsa `Amazon ürünü` gösterilir ve ASIN ikincil bilgi olarak sunulur. Popup başlığı HTML olarak değil, güvenli metin düğümü olarak işler.

Servis çalışanı yeniden başladığında önceki oturumdan kalan `checking` kayıtları `CHECK_INTERRUPTED` hatasıyla başarısız duruma alınır; son başarılı fiyat ve zamanı korunur. Kontrol durumu popup her açıldığında değil, yalnızca servis çalışanı başlangıcında kurtarılır.

### Otomatik kontrol

`chrome.storage.local` içindeki `automaticChecks` ayarı `{ version: 1, enabled: true, intervalMinutes: 360 }` biçimindedir. Altı saatlik aralık bu sürümde sabittir. Ayrı `automaticCheckState` (sürüm 1), sıradaki alarm zamanını, istekler arası en erken zamanı, bozuk/eksik zaman damgaları için koruyucu başlangıç zamanlarını ve gerekirse güvenli izin hata kodunu tutar. Ürün izleme listesi şeması değişmez.

Uygunluk, ürünün **son denenen** kontrolünden itibaren geçen gerçek altı saate göre belirlenir. Başarısız kontroller ve elle yenileme de bu süreyi yeniden başlatır. Hiç deneme yoksa eklenme zamanı kullanılır; iki zaman da geçersizse kalıcı koruyucu zaman kaydedilir ve en az altı saat beklenir. Böylece tekrar eden hatalar hızlı isteklere dönüşmez.

Chrome alarmı her seferinde en çok bir uygun ürünü kontrol eder; başka uygun ürün varsa sonraki denemeyi en az bir dakika sonrasına kurar. Bu tek seferlik alarm ve ara süresi yerel depoda tutulur. Çalışan yeniden başlarsa eksik alarm yeniden kurulur ve yarım kalan kontrol `CHECK_INTERRUPTED` olarak işaretlenir; son deneme zamanı korunur. Kaçırılan altı saatlik dönemler toplu halde tekrar oynatılmaz. Chrome kapalıyken kontrol yapılmaz; uyku, tarayıcı ve alarm gecikmeleri hedef zamanı ileri kaydırabilir.

Otomatik kontrol kapatıldığında yalnızca uzantının kendi alarmı temizlenir; başlamış bir istek tamamlanabilir, yeni otomatik istek başlatılmaz. Elle kontroller açık kalır. Amazon Türkiye site izni yoksa otomatik akış izin penceresi açmaz veya ağ isteği yapmaz; popup izin gereksinimini gösterir ve yeniden denemeyi sınırlar. Sık veya çok sayıda fiyat isteği Amazon tarafından kısıtlanabilir. Bildirimler, hedef fiyatlar ve geçmiş fiyat grafikleri henüz uygulanmadı.

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

21 Ekim 2026'da açık ürün sayfasındaki elle çalıştırılan `document.querySelector("#corePrice_feature_div .a-offscreen")?.textContent?.trim()` ifadesi `36.399,00TL` sonucunu verdi. Bu, canlı sayfa DOM'undaki gözlemdir; 36.399,00 TL sabit beklenen fiyat değildir. Ayrıca kullanıcı gerçek Chrome testlerinde doğrudan/uzun ürün URL'leri, kısa bağlantı çözümleme ve görünür Amazon sekmesi açmadan arka plan fiyat sorgusunu doğruladı. Comet davranışı ayrıca doğrulanmalıdır.

Yalnızca `#corePrice_feature_div .a-offscreen` içindeki satış fiyatı adayı kabul edilir. Adayın üst DOM öğelerinden birinde `apex-priceperuni` ile başlayan ayrı bir sınıf token'ı varsa bu bilinen birim fiyatı bileşeni dışarıda bırakılır; birim fiyatı asla ürün satış fiyatı olarak kullanılmaz. Birden fazla satış fiyatı adayı kalırsa sonuç yine belirsiz sayılır. Reklam, öneri, eski fiyat veya taksit tutarına geçilmez. Fiyat bulunamazsa veya Amazon robot doğrulaması, erişim engeli, oturum açma, HTTP hatası, yönlendirme ya da ağ hatası dönerse sorgu başarısız kaydedilir. Başarısız sonuç eski başarılı fiyatı değiştirmez. Giriş yapılmış tarayıcı oturumunun çerezleri gönderilmez; dolayısıyla kullanıcıya özel fiyatlar görülemeyebilir. CAPTCHA aşma veya görünür sekme çözümü yoktur.

Manifest `storage`, `offscreen`, zamanlanmış işleri servis çalışanı sürekli açık kalmadan çalıştırmak için `alarms` ve iki isteğe bağlı site erişimi içerir: `https://www.amazon.com.tr/*` ve `https://amzn.eu/*`. Normal ürün URL'si `amzn.eu` erişimi istemez; bu izin yalnızca kısa bağlantı girildiğinde istenir. Tarama geçmişi, çerez API'si, diğer siteler, uzak kod, sunucu hesabı veya telemetri kullanılmaz. HTML saklanmaz; yalnızca watchlist kayıtları ve önceki prototiple uyum için son tekil sorgu tanısı tutulur.

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

Node.js 20+ ile depo kökünde `npm test` çalıştırın. Harici paket kurulumu gerekmez. Testler sentetik HTML, kontrollü saat ve taklit Chrome storage/alarms/permission/fetch API'leri kullanır; gerçek Amazon ağına bağlanmaz.

### Geliştirici otomatik kontrol testi

Altı saat beklemeden gerçek otomatik kontrol yolunu ve Chrome alarm teslimini bir kez denemek için depo kökünde `npm run dev:prepare` çalıştırın. Komut, Git tarafından yok sayılan `.fiyatnobeti-dev` klasörüne ayrı bir geliştirici yüklemesi hazırlar; normal `manifest.json` değişmez ve standart yüklemede geliştirici komutları ile test alarmı bulunmaz.

Chrome'da `chrome://extensions` sayfasında Geliştirici modu'nu açıp `.fiyatnobeti-dev` klasörünü paketlenmemiş uzantı olarak yükleyin. macOS dosya seçicisinde gizli klasörü göstermek gerekirse `Command + Shift + .` kullanın. Comet paketlenmemiş Chromium uzantılarını destekliyorsa uzantı yönetimi ekranında aynı klasörü yükleyin. **FiyatNöbeti (Geliştirici)** popup'ından en az bir ürün ekleyerek Amazon Türkiye iznini kullanıcı eylemiyle verin. Otomatik kontrolün açık kaldığını doğrulayın.

Uzantı kartındaki servis çalışanı **İncele** bağlantısını açın ve yaklaşık iki dakika sonrası için tek seferlik gerçek Chrome alarmını kurun:

```javascript
await globalThis.fiyatNobetiDev.scheduleOneAutomaticCheckTest(2)
```

Gecikme tam sayı olarak 1–5 dakika aralığındadır. Sonuç `testId`, hedef `asin`, UTC tabanlı `scheduledAt`, benzersiz `alarmName` ve `scheduled` durumunu içerir. Bu komut Amazon isteğini hemen başlatmaz. DevTools'u kapatın; Chrome veya Comet'i açık, Mac'i test süresince uyanık bırakın. Tarayıcı alarmı doğal biçimde teslim ettiğinde servis çalışanı en fazla bir gerçek otomatik ürün kontrolü başlatır.

Yaklaşık iki dakika sonra servis çalışanı DevTools'unu yeniden açıp sonucu okuyun:

```javascript
await globalThis.fiyatNobetiDev.getLastAutomaticAlarmTest()
```

`deliveredAt` alarmın gerçekten teslim edildiği, `completedAt` kontrolün tamamlandığı zamanı gösterir. `requestStarted`, Amazon isteğinin başlayıp başlamadığını belirtir. Durumların anlamı:

- `scheduled`: Alarm kuruldu; henüz teslim edilmedi.
- `running`: Alarm teslim edildi; kontrol devam ediyor.
- `success`: Alarm teslim edildi ve fiyat kontrolü başarıyla tamamlandı.
- `failure`: Alarm teslim edildi fakat izin, ağ, HTTP veya fiyat ayrıştırma hatasıyla tamamlandı.
- `skipped`: Ürün kaldırıldığı/değiştiği, otomatik kontrol kapalı olduğu veya başka bir kontrol çalıştığı için istek başlatılmadı.
- `interrupted`: Alarm teslim edildikten sonra servis çalışanı kontrol tamamlanmadan sonlandı; test yeniden oynatılmaz.

Başarılı sonuçtan sonra popup'ı yeniden açıp ürün fiyatını ve son kontrol zamanını inceleyin. DevTools'ta `await chrome.alarms.get("fiyatnobeti:automatic-price-check")` ile normal üretim alarmının kaldığını doğrulayın. Kontrol edilen ürünün altı saatlik uygunluğu yeni son deneme zamanından hesaplanır; başka uygun ürün varsa mevcut en az bir dakikalık istek aralığı korunur. Test alarmı yinelenmez.

İsteğe bağlı doğrudan kontrol komutu da kullanılabilir:

```javascript
await globalThis.fiyatNobetiDev.runOneAutomaticCheck()
```

Bu eski komut kontrolü hemen başlatır ve alarm teslimini sınamaz. Her iki geliştirici yolu da mevcut güvenli Amazon fetch'i ile ayrıştırmasını kullanır, izin penceresi açmaz ve devam eden ürün kontrolüyle çakışmaz.

Tek kayıtlık tanı `chrome.storage.local` içindeki `fiyatnobetiDeveloperAutomaticAlarmTest` anahtarında tutulur; HTML, yanıt gövdesi veya çerez saklanmaz. Test alarmının adı `fiyatnobeti:dev:automatic-check-test:<testId>` biçimindedir ve üretim alarmından ayrıdır. Bekleyen test servis çalışanı yeniden başlasa da korunur; `running` durumda kesilen test `interrupted` olur ve tekrar istek başlatmaz.

Standart sürüme dönmek için geliştirici yüklemesini uzantı ekranından kaldırın ve depo kök klasörünü yeniden paketlenmemiş uzantı olarak yükleyin. `.fiyatnobeti-dev` klasörü istenirse silinebilir. Doğal test alarmının gerçek Chrome veya Comet teslimi ayrıca elle doğrulanmalıdır; otomatik testler alarm olayını, API'leri, saati ve ağı taklit eder.

### Geliştirici fiyat yanıtı ve otomatik kontrol tanıları

`npm run dev:prepare` ile üretilen ayrı **FiyatNöbeti (Geliştirici)** yüklemesinde, kaydedilmiş tek bir ürünün arka plan HTML yanıtını ek bir istek yapmadan incelemek için servis çalışanının DevTools Konsolu'nda şunu çalıştırın:

```javascript
await globalThis.fiyatNobetiDev.diagnoseProduct("6259174209")
```

Bu komut yalnızca açıkça çağrıldığında bir ürün isteği yapar; normal izin, kimlik bilgisi göndermeme, yönlendirme, 20 saniye ve 5 MiB sınırlarını kullanır. Ürün listesindeki fiyat ve kontrol zamanlarını değiştirmez; eşzamanlı kontrol varsa `CHECK_BUSY`, ürün kaldırılırsa `CHECK_CANCELLED` döner. Raporda UTC başlangıç/bitiş zamanları, güvenli HTTP durumu ve MIME türü, son URL'nin yalnızca sınıfı, yaklaşık bayt sayısı, başlık/ana fiyat kapsayıcısının varlığı, birincil ve alternatif yapıların sınırlı sayıları ve mevcut ayrıştırıcının sonucu yer alır. Alternatifler **fiyat kaynağı olarak kullanılmaz**. Ham HTML, fiyat metni, başlık metni, çerez, tam URL ve HTTP başlıkları döndürülmez veya saklanmaz. `PRICE_MISSING` ile ağ/HTTP/bot sayfası ayrımını gözlemlemeyi sağlar; tarayıcıda görülen DOM ile arka plan HTML'sinin aynı olduğunu varsaymaz.

Geliştirici yüklemesinde, gelecekteki otomatik kontrol olaylarını okumak için:

```javascript
await globalThis.fiyatNobetiDev.getAutomaticCheckDiagnostics()
```

Yerel depodaki sürüm 1 olay günlüğü son **40** kaydı tutar: servis çalışanının başlaması, normal alarmın kurulması ve gerçekten teslim edilmesi, ürün seçimi, istek başlangıcı, tamamlanma/atlanma ve kesilmiş `checking` kaydının toparlanması. Planlanan alarm tek başına başarılı kontrol anlamına gelmez; `automatic_request_started` gerçek Fetch başlangıcını gösterir. Bir önceki servis çalışanında yarım kalan kontrol `check_interrupted` olarak kaydedilir, tamamlandı olarak değil. Olaylar yalnızca UTC zaman, tür, ilgili ASIN/alarm adı, planlanan zaman, güvenli sonuç/hata kodu ve istek başlayıp başlamadığını içerir. Üretim uzantısında bu Konsol API'leri ve geliştiriciye özel olay depolaması yoktur. Mevcut altı saatlik aralık, en az bir dakikalık hız sınırlaması ve eski geliştirici alarm komutları değişmez.

Mac'te Chrome için `chrome://extensions` üzerinden, Comet destekliyorsa uzantılar ekranından `.fiyatnobeti-dev` klasörünü yükleyin; mevcut Amazon izinlerini verin ve hedef ASIN'i ürün listesine ekleyin. Servis çalışanı **İncele** bağlantısında önce `diagnoseProduct("6259174209")` raporunu okuyun. Sonra DevTools'u kapatıp tarayıcı açıkken sıradan otomatik kontrolleri bekleyin; daha sonra tekrar açıp `getAutomaticCheckDiagnostics()` sonucunda planlanma, teslim, istek ve bitiş zamanlarını ayrı ayrı karşılaştırın. UTC olay zamanlarını Türkiye saati için üç saat ileri alarak macOS `pmset` kayıtlarıyla elle kıyaslayabilirsiniz. Uzantı macOS DarkWake durumunu algılayamaz; **22 Ekim 2026'daki geçmiş DarkWake olayları yeni günlükle geriye dönük oluşturulamaz**. Bu yalnızca gelecekteki olayları aydınlatır. Otomatik testler sahte ağ ve alarmlarla çalışır; gerçek Chrome/Comet HTML yanıtını veya uyku sırasında alarm teslimini doğrulamaz.

Chrome'da elle test için `chrome://extensions` sayfasından uzantıyı yeniden yükleyin. Popup'ta otomatik kontrolün **Açık · 6 saatte bir** olduğunu doğrulayın; iki Amazon ürünü ekleyin ve ilk fiyat kontrollerini inceleyin. Popup'ı kapatıp açınca ayar ve ürünler kalmalıdır. Bir ürünü elle yenileyin; onun sonraki otomatik kontrolü son denemeden altı saat önce gerçekleşmemelidir. Otomatik kontrolü kapatın, elle yenilemeyi tekrar deneyin ve yeni otomatik kontrol olmadığını doğrulayın. Yeniden açıp Chrome çalışır durumdayken yeterli süre bekleyin; başarılı/başarısız otomatik denemenin zamanını ve eski başarılı fiyatın korunmasını inceleyin. Uzantının servis çalışanı DevTools penceresinde `chrome.alarms.get("fiyatnobeti:automatic-price-check")` ile alarmın varlığını, kapatınca silindiğini ve açınca geri geldiğini kontrol edebilirsiniz. Görünür Amazon sekmesi açılmamalıdır. Comet'te aynı akış, paketlenmemiş uzantı ve gerekli MV3 API'leri destekleniyorsa denenebilir. Otomatik kontrollerin gerçek Chrome/Comet davranışı henüz ayrıca doğrulanmamıştır.
