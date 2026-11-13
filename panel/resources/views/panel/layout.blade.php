<!doctype html>
<html lang="fa" dir="rtl">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="robots" content="noindex, nofollow">
    <meta name="referrer" content="no-referrer">
    <meta name="color-scheme" content="dark light">
    <meta name="panel-idle" content="{{ config('najva.idle_minutes', 15) * 60 }}">
    <meta name="panel-pulse" content="{{ route('panel.pulse') }}">
    <meta name="panel-login" content="{{ url(\Laravel\Nova\Nova::path().'/login') }}">
    <meta name="panel-find" content="{{ route('panel.rooms.find') }}">
    @can('legal.view')<meta name="panel-cases" content="{{ route('panel.cases') }}">@endcan
    <title>@yield('title', 'پنل') · نجوا</title>
    <link rel="icon" href="{{ asset('panel/icon.svg') }}" type="image/svg+xml">
    <link rel="preload" href="{{ asset('panel/fonts/Vazirmatn.woff2') }}" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="{{ asset('panel/panel.css') }}?v={{ $assetV }}">
    <script src="{{ asset('panel/theme.js') }}?v={{ $assetV }}"></script>
    <script src="{{ asset('panel/panel.js') }}?v={{ $assetV }}" defer></script>
</head>
@php
    $user = auth()->user();
    $groups = [
        'نمای کلی' => [
            ['panel.dashboard', 'home', 'داشبورد', 'view', null, 'dashboard', 'G D'],
        ],
        'عملیات' => [
            ['panel.rooms', 'chat', 'اتاق‌ها', 'view', $navBadges['online'] ?: null, 'rooms', 'G R'],
            ['panel.reports', 'flag', 'گزارش‌های تخلف', 'view', $navBadges['reports'] ?: null, 'reports', 'G T'],
            ['panel.blocks', 'shield', 'مسدودی IP', 'view', null, 'blocks', null],
            ['panel.notices', 'megaphone', 'اعلان سراسری', 'view', null, 'notices', null],
        ],
        'حقوقی' => [
            ['panel.cases', 'scale', 'پرونده‌های قضایی', 'legal.view', $navBadges['cases'] ?: null, 'cases', 'G C'],
            ['panel.transparency', 'chart', 'گزارش شفافیت', 'legal.view', null, 'transparency', null],
        ],
        'سیستم' => [
            ['panel.audit', 'list', 'لاگ ممیزی', 'audit.view', null, 'audit', 'G A'],
            ['panel.team', 'users', 'تیم و دسترسی', 'team.manage', null, 'team', null],
            ['panel.settings', 'gear', 'تنظیمات', 'view', null, 'settings', 'G S'],
        ],
    ];
    $initials = mb_substr(trim($user->name ?? '؟'), 0, 1);
    $mobileTabs = ['dashboard', 'rooms', 'cases', 'reports'];
@endphp
<body class="@hasSection('list') with-list @endif @yield('bodyClass')">
<div class="app">
    <nav class="side" id="side" aria-label="بخش‌ها">
        <div class="side-top">
            <a class="brand" href="{{ route('panel.dashboard') }}">
                <span class="logo-mark" aria-hidden="true">ن</span>
                <span class="brand-text"><b>نجوا</b><small>کنسول عملیات و انطباق</small></span>
            </a>
            <button type="button" class="icon-btn side-collapse" data-nav-toggle title="جمع / باز کردن منو">@icon('sidebar')</button>
        </div>

        <button type="button" class="cmd-trigger" data-palette title="جستجو و فرمان">
            @icon('search')<span class="cmd-label">جستجو یا فرمان…</span><kbd>Ctrl K</kbd>
        </button>

        <div class="side-scroll">
            @foreach ($groups as $gLabel => $items)
                @php($visible = collect($items)->filter(fn ($i) => Gate::allows($i[3])))
                @if ($visible->isNotEmpty())
                    <div class="nav-group">
                        <div class="nav-label">{{ $gLabel }}</div>
                        @foreach ($visible as [$route, $ic, $label, $ability, $badge, $key, $keys])
                            @php($on = request()->routeIs($route) || request()->routeIs($route.'.*'))
                            <a href="{{ route($route) }}" class="nav-item {{ $on ? 'active' : '' }}" data-tip="{{ $label }}" data-cmd="{{ $label }}" data-cmd-icon="{{ $ic }}" data-cmd-keys="{{ $keys }}" data-nav="{{ $key }}" @if ($on) aria-current="page" @endif>
                                @icon($ic)
                                <span class="nav-text">{{ $label }}</span>
                                <span class="badge {{ $key === 'reports' && $navBadges['severe'] ? 'red' : '' }}" data-pulse="{{ $key }}" @if (! $badge) hidden @endif>{{ $badge ? $J->digits($badge) : '' }}</span>
                            </a>
                        @endforeach
                    </div>
                @endif
            @endforeach
        </div>

        <div class="side-foot">
            <div class="sys-status" data-tip="وضعیت همگام‌سازی با رله">
                <span class="pulse-dot" data-live-dot></span>
                <span class="nav-text">رله متصل · <span data-live-ago>همگام</span></span>
            </div>
            <div class="user-card">
                <span class="av sm t{{ \App\Support\Icons::tone($user->email ?? 'x') }}">{{ $initials }}</span>
                <span class="user-meta">
                    <b>{{ $user->name }}</b>
                    <small>{{ $user->roleLabel() }}</small>
                </span>
                <div class="user-actions">
                    <button type="button" class="icon-btn" data-theme-toggle data-tip="پوسته‌ی روشن / تیره">@icon('moon', 'ic i-moon')@icon('sun', 'ic i-sun')</button>
                    <a class="icon-btn" href="{{ url(\Laravel\Nova\Nova::path().'/user-security') }}" data-tip="حساب من، رمز و دومرحله‌ای">@icon('fingerprint')</a>
                    <form method="post" action="{{ route('panel.logout') }}">
                        @csrf
                        <button class="icon-btn" data-tip="خروج">@icon('logout')</button>
                    </form>
                </div>
            </div>
        </div>
    </nav>

    @hasSection('list')
        <aside class="list-pane">
            @yield('list')
        </aside>
    @endif

    <main class="main-pane">
        @yield('main')
    </main>

    @hasSection('info')
        <aside class="info-pane" id="info-pane">
            <button type="button" class="icon-btn info-close" data-toggle-info aria-label="بستن">@icon('x')</button>
            @yield('info')
        </aside>
    @endif
</div>

{{-- phones: bottom tab bar; the full menu opens as a drawer --}}
<nav class="tabbar" aria-label="بخش‌های اصلی">
    @foreach ($groups as $items)
        @foreach ($items as [$route, $ic, $label, $ability, $badge, $key])
            @if (in_array($key, $mobileTabs, true))
                @can($ability)
                    <a href="{{ route($route) }}" class="tab {{ request()->routeIs($route) || request()->routeIs($route.'.*') ? 'active' : '' }}">
                        @icon($ic)<span>{{ \Illuminate\Support\Str::before($label, ' ') }}</span>
                        <span class="badge {{ $key === 'reports' && $navBadges['severe'] ? 'red' : '' }}" data-pulse="{{ $key }}" @if (! $badge) hidden @endif>{{ $badge ? $J->digits($badge) : '' }}</span>
                    </a>
                @endcan
            @endif
        @endforeach
    @endforeach
    <button type="button" class="tab" data-drawer>@icon('menu')<span>بیشتر</span></button>
</nav>
<div class="scrim" data-drawer-close></div>

{{-- command palette --}}
<dialog class="palette" id="palette" aria-label="جستجو و فرمان">
    <div class="pal-search">@icon('search')<input type="text" placeholder="کد اتاق، شماره پرونده یا نام بخش…" autocomplete="off" spellcheck="false" data-pal-input><kbd>Esc</kbd></div>
    <div class="pal-list" data-pal-list role="listbox"></div>
    <div class="pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> جابه‌جایی</span><span><kbd>Enter</kbd> باز کردن</span><span class="pal-hint">کد ۷ رقمی ⟵ پرش مستقیم به اتاق</span></div>
    <template data-pal-actions>
        @can('legal.manage')<a href="{{ route('panel.cases.create') }}" data-cmd="ثبت پرونده‌ی جدید" data-cmd-icon="plus" data-cmd-group="کارها"></a>@endcan
        @can('notices.manage')<a href="{{ route('panel.notices') }}" data-cmd="ارسال اعلان سراسری" data-cmd-icon="megaphone" data-cmd-group="کارها"></a>@endcan
        <a href="{{ route('panel.rooms', ['f' => 'held']) }}" data-cmd="اتاق‌های توقیف‌شده" data-cmd-icon="lock" data-cmd-group="فیلترها"></a>
        <a href="{{ route('panel.rooms', ['f' => 'suspended']) }}" data-cmd="اتاق‌های مسدود" data-cmd-icon="ban" data-cmd-group="فیلترها"></a>
        <a href="{{ route('panel.rooms', ['f' => 'watched']) }}" data-cmd="اتاق‌های تحت پایش" data-cmd-icon="eye" data-cmd-group="فیلترها"></a>
        @can('legal.view')<a href="{{ route('panel.cases', ['f' => 'overdue']) }}" data-cmd="پرونده‌های گذشته از مهلت" data-cmd-icon="clock" data-cmd-group="فیلترها"></a>@endcan
        <a href="{{ url(\Laravel\Nova\Nova::path().'/user-security') }}" data-cmd="امنیت حساب من (رمز، دومرحله‌ای، passkey)" data-cmd-icon="fingerprint" data-cmd-group="حساب"></a>
        <button type="button" data-cmd="تغییر پوسته‌ی روشن / تیره" data-cmd-icon="moon" data-cmd-group="حساب" data-theme-toggle></button>
        @foreach (['search', 'chat', 'scale', 'clock', 'plus', 'megaphone', 'lock', 'ban', 'eye', 'fingerprint', 'moon', 'home', 'flag', 'shield', 'chart', 'list', 'users', 'gear', 'back'] as $i)
            <span data-icon-src="{{ $i }}">@icon($i)</span>
        @endforeach
    </template>
</dialog>

{{-- styled confirmation for destructive forms (replaces window.confirm) --}}
<dialog class="confirm" id="confirm-dlg">
    <div class="dlg-head"><span class="av red">@icon('alert')</span><h2>تأیید اقدام</h2></div>
    <div class="dlg-body"><p data-confirm-text></p></div>
    <div class="dlg-foot">
        <button type="button" class="btn danger" data-confirm-ok>بله، انجام شود</button>
        <button type="button" class="btn ghost" data-close>انصراف</button>
    </div>
</dialog>

<div class="toasts" aria-live="polite">
    @if (session('panel.flash'))
        <div class="toast ok">@icon('check')<span>{{ session('panel.flash') }}</span><button type="button" class="toast-x" aria-label="بستن">@icon('x')</button><i class="toast-bar"></i></div>
    @endif
    @foreach ($errors->all() as $err)
        <div class="toast err">@icon('alert')<span>{{ $err }}</span><button type="button" class="toast-x" aria-label="بستن">@icon('x')</button><i class="toast-bar"></i></div>
    @endforeach
</div>

<div class="idle-warn" id="idle-warn" hidden>
    @icon('clock')
    <span>به دلیل عدم فعالیت تا <b id="idle-left"></b> ثانیه‌ی دیگر از پنل خارج می‌شوید.</span>
    <button type="button" class="btn sm" data-idle-stay>می‌مانم</button>
</div>
</body>
</html>
