# YKMaps — reklamsız İstanbul toplu taşıma

Otobüsünün nerede olduğunu ve bir yere nasıl gideceğini gösteren, reklamsız, kişisel kullanım için bir İstanbul ulaşım uygulaması. Telefona "uygulama gibi" kurulan bir web uygulamasıdır (PWA). Yanında küçük bir Node.js sunucusu çalışır.

## Özellikler

| | |
|---|---|
| **Yakınımdaki duraklar** | Konumuna en yakın duraklar, mesafeleri, geçen hatlar ve her durak için **canlı varış süreleri**. Yürüdükçe liste güncellenir. "Harita merkezi" ile başka bir bölgeye bakabilirsin. |
| **Durak ekranı (otobüsüm nerede)** | Durağa gelen tüm otobüsler, kaç dakika kaldığı, sonraki seferler. 20 sn'de bir otomatik yenilenir. Hatta göre filtrelenebilir. |
| **Otobüs yaklaşınca alarm** | Durakta bir hattın yanındaki 🔔'a dokun: otobüs 2/5/10/15 dk kala (ya da "çıkma vaktim gelince") bildirim gelir. Sunucu takip ettiği için **uygulama kapalıyken de** çalışır (Web Push). |
| **Yetişir misin?** | Durak ekranı ve rota detayı, durağa yürüme süreni canlı varışla karşılaştırır: "3 dk içinde çık", "Yetişemezsin — sonraki 12 dk". |
| **Ne zaman çıkayım?** | Rota sonuçlarında: önümüzdeki 2 saatteki 13 çıkış saatini dener, en kısa yolculuğu ve en erken varışı gösterir; grafikten saat seçebilirsin. |
| **Favori hat değişiklik bildirimi** | Favori hatlarında güzergah değişikliği, yol çalışması ya da o hattı anan yeni bir İETT duyurusu çıkınca bildirim. |
| **İlk / son sefer** | Sefer saatlerinde ilk ve son sefer, son sefere kalan süre. |
| **İki tema** | LP-50 (açık: kâğıt, piksel etiketler, LCD durak panosu) ve Circuit (koyu: yarış siyahı, kırmızı, condensed italik). |
| **İneceğim durakta uyar** | Hat ekranında bir durağın 🚩 düğmesi ya da rota detayında "İneceğim yerde uyar": GPS ile durağa ~400 m kala uyarır (ekran açık kalır). |
| **Hat ekranı** | Güzergah haritada, iki yön, tüm duraklar (sana en yakın durak işaretli), **sefer saatleri** (iş günü/Cumartesi/Pazar, sıradaki sefer vurgulu), hatla ilgili **anlık uyarılar** (güzergah değişikliği, yol çalışması). |
| **Nasıl Giderim** | Otobüs, metro, metrobüs, Marmaray, tramvay, vapur, dolmuş dahil rota planlama. Seçenekler: en hızlı / az aktarma / az yürüme / raylı öncelikli; şimdi, kalkış ya da varış saatine göre. Süre, yürüme mesafesi, ücret, aktarma sayısı; adım adım tarif ve harita. |
| **Arama** | Hat no (500T), durak adı ya da yer/adres; haritaya uzun basarak "Buraya git / Buradan başla". |
| **Tüm hatlar** | 780+ hattın listesi, filtre ve harf/numara hızlı seçimi. |
| **Favoriler** | Ev, İş ve kendi yerlerin; favori durakların (canlı özetiyle) ve hatların. Son bakılanlar. |
| **Duyurular** | İETT'nin tüm duyuruları; duyurudaki hatlara tek dokunuşla geçiş. |
| **Diğer** | Koyu tema, çevrimdışı açılış, harita karolarını önbellekleme, ana ekrana ekleme, paylaşma. Hiç reklam, takip ya da hesap yok; favoriler sadece telefonunda saklanır. |

**Hatlar sık değiştiği için:** hat, durak ve sefer bilgileri her istekte İETT'den canlı çekilir (birkaç saatlik önbellekle). "Yakınımdaki duraklar" için kullanılan durak indeksi sunucu tarafından **her 3 günde bir arka planda otomatik yenilenir** (781 hat, ~13.200 durak).

## Kurulum

Node.js 18+ dışında hiçbir bağımlılık yok (`npm install` bile gerekmez).

### 1) Android telefonda (önerilen — her şey telefonda, Türkiye IP'si)

1. F-Droid'den **Termux** kur.
2. Termux'ta:
   ```bash
   pkg install -y nodejs git
   ```
   ```bash
   git clone https://github.com/yutuf/ykmaps.git && cd ykmaps
   ```
   ```bash
   bash termux-start.sh
   ```
3. Chrome'da `http://localhost:8080` aç → menü → **Ana ekrana ekle**.

Termux açık kaldıkça uygulama çalışır. Telefon Türkiye'de olduğu için İBB'nin canlı araç konumu servisi de çalışır (hat haritasında otobüsleri canlı görürsün).

### 2) Evdeki bilgisayarda / Raspberry Pi'de

```bash
git clone https://github.com/yutuf/ykmaps.git && cd ykmaps && node server.js
```

Telefondan aynı Wi-Fi'de `http://<bilgisayar-ip>:8080` ile açılır. Dışarıdan erişmek için Tailscale gibi bir VPN en kolayıdır. Not: konum ve bildirim için tarayıcılar HTTPS ister (`localhost` hariç); Tailscale'in `tailscale serve` özelliği HTTPS verir.

### 3) Bulutta (Render, Fly, VPS…)

- **Render:** repo'yu bağla, `render.yaml` hazır (ücretsiz planda 15 dk boşta kalınca uyur, ilk açılış ~30 sn).
- **Docker:** `docker build -t ykmaps . && docker run -p 8080:8080 ykmaps`

Yurt dışındaki sunucularda İBB'nin `api.ibb.gov.tr` servisi yabancı IP'leri engellediği için **haritada canlı otobüs konumu görünmez**; varış süreleri, hatlar, sefer saatleri, rota planlama ve diğer her şey çalışır.

## Ortam değişkenleri

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `8080` | Sunucu portu |
| `HOST` | `0.0.0.0` | Dinlenen adres |
| `DISABLE_CRAWL` | — | `1` ise durak indeksi otomatik yenilenmez |
| `STOPS_FILE` / `LINES_FILE` | `data/…json` | İndeks dosyalarının yeri |
| `DATA_DIR` | `data/` | Bildirim anahtarı (`vapid.json`) ve abonelik/alarm kayıtları (`push.json`) |
| `DISABLE_PUSH` | — | `1` ise sunucu tarafı bildirimler kapalı |

Durak indeksini elle yenilemek: `npm run build-stops` (~5 dk).

## Veri kaynakları

- **iett.istanbul** — hat/durak arama, canlı durak varış tahminleri, durak listeleri, güzergah çizgileri, sefer saatleri, hat uyarıları, duyurular.
- **nasilgiderim.iett.gov.tr** — çok modlu rota planlama ve yer arama.
- **api.ibb.gov.tr** (İBB Açık Veri, sadece Türkiye IP'lerinden) — hattaki araçların canlı konumu.
- **OpenStreetMap** — harita.

Uygulama bu herkese açık servisleri kişisel kullanım için okur; İETT veya İBB ile bir bağlantısı yoktur. Servisleri yormamak için sunucu yanıtları önbellekler (varış süreleri 15 sn, hat bilgileri 3 sa).

## Geliştirme

```bash
npm test
```

```
server.js            HTTP sunucu: /api/* + public/ (statik PWA)
src/iett.js          Veri kaynaklarına erişim + önbellek
src/parse.js         HTML/JSON ayrıştırıcılar
src/stops-index.js   Şehir geneli durak indeksi (yakındaki duraklar)
public/js/           Arayüz (vanilla JS modülleri, Leaflet harita)
test/                Ayrıştırıcı testleri (gerçek yanıt örnekleriyle)
```
