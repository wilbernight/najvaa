# راهنمای نصب Laravel Nova روی XAMPP (localhost/panel)

این فایل خلاصه‌ی کاری هست که برای بالا آوردن پنل Nova روی سیستم شما انجام شد، به‌همراه اطلاعات لازم برای استفاده و نگهداری بعدی.

## ۱. آدرس‌ها و اطلاعات ورود

- **صفحه ورود پنل:** http://localhost/panel/nova
  (خود آدرس `http://localhost/panel` صفحه‌ی خوش‌آمدگویی پیش‌فرض لاراول رو نشون میده، نه پنل — پنل ادمین زیرمسیر `/nova` هست)
- **ایمیل ورود:** `accounts@wilbernight.com`
- **رمز عبور:** `ChangeMe123!`

> **پیشنهاد:** بعد از اولین ورود، از منوی کاربری (بالا-راست) رمز عبور رو عوض کنید.

## ۲. اطلاعات دیتابیس

- نوع: MySQL (همون سرویس MySQL خود XAMPP)
- نام دیتابیس: `panel`
- کاربر: `root`
- رمز: (خالی)

می‌تونید دیتابیس رو از طریق phpMyAdmin (`http://localhost/phpmyadmin`) هم ببینید.

## ۳. پروژه کجاست؟

- مسیر اصلی پروژه‌ی لاراول: `C:\xampp\htdocs\panel`
- سورس پکیج Nova (که دانلود کرده بودید): `C:\Users\wilbernight0xff\Downloads\nova-5-10-1`
  این پوشه **نباید حذف یا جابه‌جا بشه**، چون پروژه از طریق Composer (به روش «path repository») مستقیماً به همین پوشه وصله. اگر جابه‌جاش کنید، باید مسیر رو در `C:\xampp\htdocs\panel\composer.json` (بخش `repositories`) اصلاح کنید.

## ۴. چه کارهایی انجام شد؟ (خلاصه فنی)

1. Composer روی سیستم نصب شد (`C:\xampp\php\composer.phar`) چون از قبل نصب نبود.
2. اکستنشن `zip` در PHP فعال شد (در `C:\xampp\php\php.ini`) چون Nova بهش نیاز داشت.
3. یک پروژه‌ی تازه‌ی Laravel در `C:\xampp\htdocs\panel` ساخته شد.
4. دیتابیس `panel` در MySQL ساخته و در فایل `.env` پروژه تنظیم شد.
5. پکیج Nova به‌عنوان یک composer path repository به پروژه اضافه و نصب شد (`composer require laravel/nova:5.10.1`).
6. دستور `php artisan nova:install` اجرا شد و یک کاربر ادمین ساخته شد.
7. چون پنل قراره زیر مسیر `/panel` (نه روی ریشه‌ی سایت) در Apache سرو بشه، این تنظیمات اضافه شد:
   - در `C:\xampp\apache\conf\extra\httpd-vhosts.conf`: یک `Alias /panel` به پوشه‌ی `public` پروژه، و یک قانون بازنویسی برای اینکه درخواست‌های داخلی Nova به آدرس `/nova-api/...` (که بدون پیشوند `/panel` ارسال میشن) درست به برنامه برسن.
   - در `C:\xampp\htdocs\panel\public\.htaccess`: خط `RewriteBase /panel` اضافه شد.
   - در `C:\xampp\htdocs\panel\config\app.php`: کلید `mix_url` اضافه شد تا آدرس فایل‌های CSS/JS پنل درست ساخته بشن.
   - در `C:\xampp\htdocs\panel\app\Providers\NovaServiceProvider.php`: مقدار `base` که در جاوااسکریپت Nova استفاده میشه اصلاح شد تا مسیر `/panel` رو هم در نظر بگیره.

## ۵. روشن/خاموش کردن Apache و MySQL

روی این سیستم، اسکریپت‌های پیش‌فرض XAMPP (`apache_stop.bat` و مشابه آن) به‌درستی نصب نشده بودن (یک مسیر placeholder جایگزین نشده در اون‌ها هست) و کار نمی‌کنن. برای مدیریت سرویس‌ها:

- **از طریق XAMPP Control Panel:** فایل `C:\xampp\xampp-control.exe` رو اجرا کنید. اگر دکمه‌ی Stop روی Apache جواب نداد (چون Apache توسط این نشست بدون control panel روشن شده)، از روش زیر استفاده کنید.
- **دستی از خط فرمان (PowerShell/CMD):**
  ```
  taskkill /F /IM httpd.exe
  ```
  و برای روشن کردن دوباره:
  ```
  C:\xampp\apache\bin\httpd.exe -f C:\xampp\apache\conf\httpd.conf
  ```
  (این دستور باید در یک پنجره‌ی جدا اجرا بمونه، یا با XAMPP Control Panel هماهنگ بشه.)

> اگر بعد از ری‌استارت ویندوز پنل بالا نیومد، احتمالاً Apache یا MySQL خاموش هستن — از XAMPP Control Panel هر دو رو Start کنید.

## ۶. اگر بعداً خواستید تغییری در پروژه بدید

- فایل‌های پروژه در `C:\xampp\htdocs\panel` هستن (ساختار استاندارد Laravel).
- برای اجرای دستورات artisan:
  ```
  C:\xampp\php\php.exe C:\xampp\htdocs\panel\artisan <command>
  ```
- برای دستورات composer:
  ```
  C:\xampp\php\php.exe C:\xampp\php\composer.phar <command>
  ```
  (این دو دستور رو از داخل پوشه‌ی `C:\xampp\htdocs\panel` اجرا کنید.)

## ۷. نکته‌ی امنیتی

الان `APP_DEBUG=true` هست (مناسب برای توسعه‌ی محلی). اگر این پنل قراره فقط روی همین سیستم و برای خودتون بمونه مشکلی نیست، ولی اگر قرار شد جایی در دسترس دیگران (شبکه/اینترنت) قرار بگیره، حتماً قبلش:
- `APP_DEBUG=false` کنید،
- رمز ادمین رو عوض کنید،
- و به تنظیمات امنیتی بیشتر لاراول/Nova برای دیپلوی عمومی سر بزنید.
