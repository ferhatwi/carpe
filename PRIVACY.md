# Privacy Policy — Carpe

[English](#english) · [Türkçe](#türkçe)

---

## English

**Last updated:** November 18, 2026

**Carpe - Clip Vault for YouTube** ("Carpe") is a local-first Chrome extension designed to let you save, trim, and replay YouTube video clips without collecting personal data or relying on external developer servers.

### 1. Data We Collect

**Carpe does not collect, transmit, sell, or share any personal data with the developer or third-party analytics/advertising services.**

There are no external Carpe servers, no user accounts, no telemetry, and no tracking scripts.

### 2. Data Stored by the Extension

To provide its core functionality, Carpe stores only the data you explicitly create or configure:

- **Saved clips:** YouTube video ID, video title, optional clip title you enter, start and end timestamps, and creation/update timestamps.
- **Extension settings & sync state:** Your Chrome Sync preference, local/cloud sync status, deletion records (tombstones) used to keep deletions consistent across devices, and UI preferences (such as sidebar state).

### 3. Where Your Data Is Stored

- **Local Storage (`chrome.storage.local`):** All clips and settings are always saved locally on your device first.
- **Chrome Sync (`chrome.storage.sync`):** Enabled by default to synchronize up to ~250 clips across Chrome browsers signed into your Google account (when Extensions sync is enabled in Chrome). Chrome Sync is managed entirely by Google Chrome under your Google Account privacy settings. The Carpe developer has no access to your synced data. You can disable Chrome Sync at any time in **Carpe → Settings**.

### 4. Browser Permissions & External Requests

- **YouTube (`https://www.youtube.com/*`, `https://youtube.com/*`):** Used solely to display the in-player clip trimmer and clip controls, read the current video's title and playback timestamps, and control playback boundaries when replaying saved clips.
- **Thumbnails (`https://i.ytimg.com`):** When you open the Carpe Clip Library, your browser loads public YouTube video thumbnail images directly from YouTube's image CDN so clip cards display video previews. No extension identifiers or user data are sent by Carpe.
- **Storage & Alarms (`storage`, `unlimitedStorage`, `alarms`):** Used to store your clip library locally without hitting the standard 5 MB extension storage cap, sync clips via Chrome Sync, and retry failed sync operations after temporary rate limits.

### 5. Data Export & Deletion

You remain in full control of your data at all times:

- **Export:** Download your entire clip library at any time as JSON or Markdown from **Carpe → Settings**.
- **Delete:** Delete individual clips from the YouTube player or Clip Library, archive older clips from Chrome Sync, disable Chrome Sync, or uninstall Carpe to remove its local browser storage.

### 6. Changes & Contact

If this Privacy Policy changes, the updated version will be published in this repository with a new "Last updated" date.

For questions or privacy inquiries, please open an issue at [github.com/ferhatwi/carpe/issues](https://github.com/ferhatwi/carpe/issues).

---

## Türkçe

**Son güncelleme:** 18 Kasım 2026

**Carpe - YouTube için Klip Arşivi** ("Carpe"), kişisel veri toplamadan ve harici geliştirici sunucularına bağımlı olmadan YouTube video kliplerini kaydetmenizi, kırpmanızı ve yeniden oynatmanızı sağlayan yerel öncelikli bir Chrome uzantısıdır.

### 1. Topladığımız Veriler

**Carpe; geliştiriciye veya üçüncü taraf analiz/reklam servislerine hiçbir kişisel veri toplamaz, iletmez, satmaz veya paylaşmaz.**

Carpe'ye ait harici bir sunucu, kullanıcı hesabı, telemetri veya takip kodu bulunmamaktadır.

### 2. Uzantının Sakladığı Veriler

Carpe, temel işlevlerini yerine getirmek için yalnızca sizin oluşturduğunuz veya yapılandırdığınız verileri saklar:

- **Kayıtlı klipler:** YouTube video kimliği (video ID), video başlığı, isteğe bağlı olarak girdiğiniz klip başlığı, başlangıç ve bitiş zaman damgaları ile oluşturma/güncelleme zamanları.
- **Uzantı ayarları ve senkronizasyon durumu:** Chrome Senkronizasyonu tercihiniz, yerel/bulut senkronizasyon durumu, silinen kliplerin cihazlar arasında tutarlı kalması için kullanılan silme kayıtları (tombstone) ve arayüz tercihleri (ör. yan menü durumu).

### 3. Verilerinizin Saklandığı Yerler

- **Yerel Depolama (`chrome.storage.local`):** Tüm klipler ve ayarlar her zaman öncelikle kendi cihazınızda yerel olarak saklanır.
- **Chrome Senkronizasyonu (`chrome.storage.sync`):** Google hesabınızda oturum açmış Chrome tarayıcıları arasında (~250 klibe kadar) klipleri eşitlemek için varsayılan olarak etkindir (Chrome ayarlarınızda Uzantılar senkronizasyonu açıksa). Chrome Senkronizasyonu tamamen Google Chrome tarafından ve Google Hesabınızın gizlilik ayarları kapsamında yönetilir. Carpe geliştiricisinin senkronize edilen verilerinize hiçbir erişimi yoktur. Chrome Senkronizasyonunu istediğiniz zaman **Carpe → Ayarlar** sayfasından kapatabilirsiniz.

### 4. Tarayıcı İzinleri ve Harici İstekler

- **YouTube (`https://www.youtube.com/*`, `https://youtube.com/*`):** Yalnızca oynatıcı içi klip kırpıcıyı ve klip kontrollerini göstermek, mevcut videonun başlığını ve oynatma zamanını okumak ve kayıtlı klipleri oynatırken klip sınırlarını yönetmek için kullanılır.
- **Küçük Resimler (`https://i.ytimg.com`):** Carpe Klip Kitaplığı'nı açtığınızda tarayıcınız, klip kartlarında önizleme gösterebilmek için herkese açık YouTube video küçük resimlerini doğrudan YouTube'un görsel sunucusundan yükler. Carpe bu sırada hiçbir uzantı kimliği veya kullanıcı verisi göndermez.
- **Depolama ve Alarmlar (`storage`, `unlimitedStorage`, `alarms`):** Klip kitaplığınızı 5 MB'lık standart uzantı sınırına takılmadan yerel olarak saklamak, klipleri Chrome Senkronizasyonu ile eşitlemek ve geçici hız sınırlarından sonra başarısız senkronizasyon işlemlerini yeniden denemek için kullanılır.

### 5. Veri Dışa Aktarma ve Silme

Verileriniz üzerindeki tüm kontrol her zaman sizdedir:

- **Dışa aktarma:** Tüm klip kitaplığınızı istediğiniz zaman **Carpe → Ayarlar** sayfasından JSON veya Markdown olarak indirebilirsiniz.
- **Silme:** Klipleri tek tek YouTube oynatıcısından veya Klip Kitaplığı'ndan silebilir, eski klipleri Chrome Senkronizasyonundan arşivleyebilir, Chrome Senkronizasyonunu kapatabilir veya yerel uzantı verilerini kaldırmak için Carpe'yi tarayıcınızdan kaldırabilirsiniz.

### 6. Değişiklikler ve İletişim

Bu Gizlilik Politikası güncellendiğinde yeni sürüm, güncellenmiş tarih bilgisiyle birlikte bu depoda yayımlanır.

Gizlilikle ilgili sorularınız için [github.com/ferhatwi/carpe/issues](https://github.com/ferhatwi/carpe/issues) adresinden bir konu (issue) açabilirsiniz.
