@extends('panel.layout')
@section('title', 'تنظیمات')

@section('main')
    <div class="page">
        <div class="page-head">
            <h1>تنظیمات سرویس</h1>
            <p>این تنظیمات روی رله‌ی چت اعمال می‌شوند؛ اگر رله پاسخ ندهد، ذخیره نمی‌شوند.</p>
        </div>
        @php($ro = ! Gate::allows('settings.manage'))
        <form method="post" action="{{ route('panel.settings.update') }}" class="grid two">@csrf
            <div class="card">
                <h3>@icon('archive') نگهداری داده</h3>
                <div class="field"><label>سقف کل فضای ذخیره (گیگابایت)</label><input class="input" type="number" name="cap_gb" min="1" max="500" value="{{ $s->cap_gb }}" @disabled($ro)><span class="hint">با رسیدن به سقف، قدیمی‌ترین موارد پاک می‌شوند (جز اتاق‌های توقیف‌شده).</span></div>
                <div class="field"><label>حداکثر عمر پیام‌ها (روز)</label><input class="input" type="number" name="max_days" min="1" max="3650" value="{{ $s->max_days }}" @disabled($ro)><span class="hint">موارد قدیمی‌تر خودکار پاک می‌شوند (اتاق‌های توقیف‌شده: حفظ می‌شوند).</span></div>
            </div>
            <div class="card">
                <h3>@icon('gear') قابلیت‌ها</h3>
                <label class="switch"><span>ساخت اتاق تازه<br><small class="muted">خاموش: فقط اتاق‌های موجود کار می‌کنند</small></span><input type="checkbox" name="new_rooms" value="1" @checked($s->new_rooms) @disabled($ro)></label>
                <label class="switch"><span>تماس صوتی</span><input type="checkbox" name="calls" value="1" @checked($s->calls) @disabled($ro)></label>
                <label class="switch"><span>جستجوی گیف</span><input type="checkbox" name="gif" value="1" @checked($s->gif) @disabled($ro)></label>
                <label class="switch"><span>پیش‌نمایش لینک (اینستاگرام/یوتیوب)</span><input type="checkbox" name="preview" value="1" @checked($s->preview) @disabled($ro)></label>
            </div>
            @unless ($ro)
                <div class="btn-row"><button class="btn">@icon('check') ذخیره و اعمال</button></div>
            @endunless
        </form>
        @can('settings.manage')
            <div class="card mt">
                <h3>@icon('refresh') نگهداری</h3>
                <form method="post" action="{{ route('panel.janitor') }}" class="btn-row">@csrf
                    <button class="btn ghost sm">اجرای پاک‌سازی همین حالا</button>
                    <span class="small muted">موارد منقضی، قدیمی و آپلودهای ناتمام پاک می‌شوند. اتاق‌های توقیف‌شده دست نمی‌خورند.</span>
                </form>
            </div>
        @endcan
        <div class="card mt">
            <h3>@icon('shield') امنیت پنل</h3>
            <div class="svc"><span class="dot ok"></span><span class="row-main">ورود دومرحله‌ای (TOTP) یا passkey برای همه‌ی حساب‌ها الزامی است</span></div>
            <div class="svc"><span class="dot {{ config('najva.access.enabled') ? 'ok' : 'warn' }}"></span><span class="row-main">Cloudflare Access جلوی پنل {{ config('najva.access.enabled') ? 'فعال است' : 'غیرفعال است' }}</span></div>
            <div class="svc"><span class="dot ok"></span><span class="row-main">خروج خودکار پس از {{ $J->digits(config('najva.idle_minutes')) }} دقیقه عدم فعالیت · نشست وابسته به مرورگر{{ config('najva.bind_ip') ? ' و IP' : '' }}</span></div>
            <div class="svc"><span class="dot ok"></span><span class="row-main">کارهای حساس: تأیید دوباره‌ی رمز و کد، معتبر {{ $J->digits(config('najva.stepup_minutes')) }} دقیقه</span></div>
            <div class="svc"><span class="dot ok"></span><span class="row-main">لاگ ممیزی با زنجیره‌ی هش · متن پرونده‌ها و گزارش‌ها رمزشده با کلید پنل</span></div>
            <a class="btn sm ghost" href="{{ url(\Laravel\Nova\Nova::path().'/user-security') }}">@icon('fingerprint') رمز، دومرحله‌ای و passkey من</a>
        </div>
    </div>
@endsection
