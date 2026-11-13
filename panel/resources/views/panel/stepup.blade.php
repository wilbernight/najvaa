@extends('panel.layout')
@section('title', 'تأیید هویت')

@section('main')
    <div class="placeholder">
        <form method="post" action="{{ route('panel.stepup.store') }}" class="card stepup" autocomplete="off">
            @csrf
            <div class="big">@icon('fingerprint')</div>
            <h2>تأیید دوباره‌ی هویت</h2>
            <p class="muted">این کار حساس است. رمز عبور{{ $needsCode ? ' و کد برنامه‌ی تأیید دومرحله‌ای' : '' }} را وارد کنید. تأیید تا {{ $J->digits(config('najva.stepup_minutes', 5)) }} دقیقه معتبر است.</p>
            <div class="field"><label>رمز عبور</label><input class="input" type="password" name="password" required autocomplete="current-password" autofocus></div>
            @if ($needsCode)
                <div class="field"><label>کد ۶ رقمی</label><input class="input ltr" name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="12"></div>
            @else
                <div class="alert-box warn">@icon('alert')<div>برای حساب شما TOTP فعال نیست؛ برای امنیت بیشتر آن را از «حساب من» فعال کنید.</div></div>
            @endif
            <div class="btn-row"><button class="btn">@icon('check') تأیید</button><a class="btn ghost" href="{{ $back }}">انصراف</a></div>
        </form>
    </div>
@endsection
