@extends('panel.layout')
@section('title', 'داشبورد')

@php
    use App\Support\Chart;
    $C = Chart::class;

    // 24 h traffic: devices (line) and live rooms (dashed).
    $dev = $trend->pluck('devices')->map(fn ($v) => (int) $v)->all();
    $liv = $trend->pluck('live_rooms')->map(fn ($v) => (int) $v)->all();
    $yMax = Chart::niceMax(max([1, ...$dev, ...$liv]));
    [$devLine, $devArea] = Chart::paths($dev, $yMax);
    [$livLine] = Chart::paths($liv, $yMax);
    $labels = $trend->map(fn ($m) => $J->format($m->created_at, 'H:i'))->all();
    $chartData = json_encode(['l' => $labels, 'a' => $dev, 'b' => $liv, 'max' => $yMax, 'h' => Chart::H, 't' => Chart::TOP, 'bt' => Chart::BOTTOM], JSON_UNESCAPED_UNICODE);

    // KPI sparklines (small viewBox).
    $mini = fn (array $v) => Chart::paths($v, null, 100, 34, 3, 1);
    [$kDev, $kDevA] = $mini($dev);
    [$kLiv, $kLivA] = $mini($liv);
    [$kRep, $kRepA] = $mini($reportsDaily);
    [$kCas, $kCasA] = $mini($casesDaily);
    [$thisWeek, $prevWeek] = $reportsWeek;
    $repDelta = $prevWeek ? round(($thisWeek - $prevWeek) / $prevWeek * 100) : null;

    $used = $last && $last->cap_bytes ? $last->total_bytes / $last->cap_bytes * 100 : 0;
    $ringTone = $used >= 90 ? 'full' : ($used >= 70 ? 'hot' : '');
    $svcTone = ['ok' => 'ok', 'warn' => 'warn', 'down' => 'down'];
    $hour = (int) now()->setTimezone(config('najva.timezone', 'Asia/Tehran'))->format('G');
    $greet = $hour < 5 ? 'شب بخیر' : ($hour < 12 ? 'صبح بخیر' : ($hour < 17 ? 'روز بخیر' : 'عصر بخیر'));
@endphp

@section('main')
    <div class="page">
        <div class="dash-head">
            <div class="hello">
                <div class="eyebrow">@icon('calendar') {{ $J->format(now(), 'l j F Y') }}</div>
                <h1>{{ $greet }}، {{ \Illuminate\Support\Str::before(auth()->user()->name, ' ') ?: auth()->user()->name }}</h1>
                <p>وضعیت سرویس، صف حقوقی و گزارش‌ها در یک نگاه · آخرین همگام‌سازی {{ $J->ago($last?->created_at) }}</p>
            </div>
            <div class="btn-row">
                @can('legal.manage')<a class="btn" href="{{ route('panel.cases.create') }}">@icon('plus') ثبت پرونده</a>@endcan
                @can('notices.manage')<a class="btn ghost" href="{{ route('panel.notices') }}">@icon('megaphone') اعلان سراسری</a>@endcan
                @can('legal.view')<a class="btn ghost" href="{{ route('panel.transparency') }}">@icon('chart') گزارش شفافیت</a>@endcan
            </div>
        </div>

        @if ($notice && $notice->active())
            <div class="alert-box {{ $notice->level === 'alert' ? 'danger' : ($notice->level === 'warn' ? 'warn' : '') }}">@icon('megaphone')<div><b>اعلان سراسری فعال است:</b> {{ $notice->text }}</div><a class="btn sm ghost" href="{{ route('panel.notices') }}">مدیریت</a></div>
        @endif
        @if ($cases['overdue'])
            <div class="alert-box danger">@icon('clock')<div><b>{{ $J->digits($cases['overdue']) }} پرونده‌ی قضایی</b> از مهلت پاسخ گذشته است.</div><a class="btn sm ghost" href="{{ route('panel.cases', ['f' => 'overdue']) }}">دیدن پرونده‌ها</a></div>
        @endif
        @if ($reports['severe'])
            <div class="alert-box danger">@icon('flag')<div><b>{{ $J->digits($reports['severe']) }} گزارش با اولویت بالا</b> (کودکان، تروریسم یا تهدید) منتظر بررسی است.</div><a class="btn sm ghost" href="{{ route('panel.reports') }}">بررسی</a></div>
        @endif

        <div class="kpis">
            <a class="kpi" href="{{ route('panel.rooms', ['f' => 'online']) }}">
                <div class="kpi-top">@icon('device') دستگاه آنلاین <span class="tag green">زنده</span></div>
                <div class="kpi-num" data-live="devices">{{ $J->digits($last?->devices ?? 0) }}</div>
                <div class="kpi-sub">بیشینه‌ی ۲۴ ساعت: {{ $J->digits(max([0, ...$dev])) }}</div>
                @if ($kDev)<svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none"><path class="a" d="{{ $kDevA }}"/><path class="l" d="{{ $kDev }}"/></svg>@endif
            </a>
            <a class="kpi blue" href="{{ route('panel.rooms') }}">
                <div class="kpi-top">@icon('chat') اتاق فعال</div>
                <div class="kpi-num" data-live="live">{{ $J->digits($last?->live_rooms ?? 0) }}</div>
                <div class="kpi-sub">از {{ $J->digits($rooms['total']) }} اتاق روی سرور</div>
                @if ($kLiv)<svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none"><path class="a" d="{{ $kLivA }}"/><path class="l" d="{{ $kLiv }}"/></svg>@endif
            </a>
            @can('legal.view')
                <a class="kpi violet" href="{{ route('panel.cases') }}">
                    <div class="kpi-top">@icon('scale') پرونده‌ی باز @if ($cases['overdue'])<span class="tag red">{{ $J->digits($cases['overdue']) }} دیرکرد</span>@endif</div>
                    <div class="kpi-num" data-live="cases">{{ $J->digits($cases['open']) }}</div>
                    <div class="kpi-sub">ثبت‌شده در ۱۴ روز: {{ $J->digits(array_sum($casesDaily)) }}</div>
                    <svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none"><path class="a" d="{{ $kCasA }}"/><path class="l" d="{{ $kCas }}"/></svg>
                </a>
            @endcan
            <a class="kpi {{ $reports['severe'] ? 'red' : '' }}" href="{{ route('panel.reports') }}">
                <div class="kpi-top">@icon('flag') گزارش تخلف جدید
                    @if ($repDelta !== null)<span class="tag {{ $repDelta > 0 ? 'amber' : 'green' }}">@icon($repDelta > 0 ? 'up' : 'down'){{ $J->digits(abs($repDelta)) }}٪</span>@endif
                </div>
                <div class="kpi-num" data-live="reports">{{ $J->digits($reports['new']) }}</div>
                <div class="kpi-sub">این هفته {{ $J->digits($thisWeek) }} · هفته‌ی قبل {{ $J->digits($prevWeek) }}</div>
                <svg class="spark" viewBox="0 0 100 34" preserveAspectRatio="none"><path class="a" d="{{ $kRepA }}"/><path class="l" d="{{ $kRep }}"/></svg>
            </a>
        </div>

        <div class="dash-grid">
            <section class="card">
                <h3>@icon('activity') ترافیک ۲۴ ساعت گذشته
                    <span class="legend"><span><i></i>دستگاه آنلاین</span><span><i class="b"></i>اتاق فعال</span></span>
                </h3>
                @if ($devLine)
                    <div class="chart" data-chart="{{ $chartData }}">
                        <svg viewBox="0 0 {{ Chart::W }} {{ Chart::H }}" preserveAspectRatio="none" aria-label="نمودار ترافیک">
                            @foreach ([0, .25, .5, .75, 1] as $g)
                                @php($gy = Chart::TOP + $g * (Chart::H - Chart::TOP - Chart::BOTTOM))
                                <line class="grid-l" x1="0" x2="{{ Chart::W }}" y1="{{ $gy }}" y2="{{ $gy }}"/>
                            @endforeach
                            <path class="a1" d="{{ $devArea }}"/>
                            <path class="s2" d="{{ $livLine }}"/>
                            <path class="s1" d="{{ $devLine }}"/>
                            <line class="cursor" x1="0" x2="0" y1="0" y2="{{ Chart::H }}" hidden/>
                        </svg>
                        <div class="chart-y">@foreach ([1, .75, .5, .25, 0] as $p)<span>{{ $J->digits(round($yMax * $p)) }}</span>@endforeach</div>
                        <div class="chart-axis">
                            @foreach ([0, .25, .5, .75, 1] as $p)
                                <span>{{ $labels[(int) round($p * (count($labels) - 1))] ?? '' }}</span>
                            @endforeach
                        </div>
                    </div>
                @else
                    <div class="empty-list">هنوز داده‌ای برای نمودار جمع نشده است. همگام‌سازی هر چند دقیقه یک بار انجام می‌شود.</div>
                @endif
            </section>

            <section class="card">
                <h3>@icon('archive') فضای ذخیره‌سازی</h3>
                <div class="ring">
                    <div class="ring-wrap">
                        <svg viewBox="0 0 116 116"><circle class="track" cx="58" cy="58" r="48"/>@if ($used >= 0.5)<circle class="val {{ $ringTone }}" cx="58" cy="58" r="48" stroke-dasharray="{{ Chart::ring($used) }}"/>@endif</svg>
                        <div class="ring-pct">{{ $J->digits(round($used)) }}٪</div>
                    </div>
                    <div class="ring-txt">
                        <div class="num">{{ $J->bytes($last?->total_bytes ?? 0) }}</div>
                        <div class="small muted">از سقف {{ $J->bytes($last?->cap_bytes ?? 0) }}</div>
                        <div class="small faint mt-s">{{ $used >= 90 ? 'نزدیک سقف؛ قدیمی‌ترین موارد حذف می‌شوند (به‌جز اتاق‌های توقیف‌شده).' : 'ظرفیت کافی است.' }}</div>
                    </div>
                </div>
                <div class="mini-stats">
                    <a href="{{ route('panel.rooms', ['f' => 'held']) }}"><b>{{ $J->digits($rooms['held']) }}</b><span><i class="flag hold">@icon('lock')</i>توقیف</span></a>
                    <a href="{{ route('panel.rooms', ['f' => 'suspended']) }}"><b>{{ $J->digits($rooms['suspended']) }}</b><span><i class="flag suspend">@icon('ban')</i>مسدود</span></a>
                    <a href="{{ route('panel.rooms', ['f' => 'watched']) }}"><b>{{ $J->digits($rooms['watched']) }}</b><span><i class="flag watch">@icon('eye')</i>پایش</span></a>
                </div>
            </section>
        </div>

        <div class="dash-grid">
            @can('legal.view')
                <section class="card flush">
                    <div class="card-head"><h3>@icon('scale') صف پاسخگویی قضایی</h3><span class="spacer"></span><a class="card-link" href="{{ route('panel.cases') }}">همه‌ی پرونده‌ها</a></div>
                    @if ($cases['recent']->isNotEmpty())
                        <div class="table-wrap">
                            <table>
                                <thead><tr><th>پرونده</th><th>موضوع</th><th>اولویت</th><th>مهلت</th></tr></thead>
                                <tbody>
                                @foreach ($cases['recent'] as $c)
                                    <tr>
                                        <td><a href="{{ route('panel.cases.show', $c) }}"><code>{{ $c->ref }}</code></a></td>
                                        <td><a href="{{ route('panel.cases.show', $c) }}">{{ \Illuminate\Support\Str::limit($c->subject, 48) }}</a></td>
                                        <td><span class="tag {{ ['urgent' => 'red', 'high' => 'amber', 'normal' => 'blue'][$c->priority] ?? '' }}">{{ \App\Models\LegalCase::PRIORITIES[$c->priority] ?? $c->priority }}</span></td>
                                        <td>@if ($c->due_on)<span class="tag {{ $c->overdue() ? 'red' : '' }}">@icon('clock'){{ $J->format($c->due_on, 'j F') }}</span>@else<span class="faint">—</span>@endif</td>
                                    </tr>
                                @endforeach
                                </tbody>
                            </table>
                        </div>
                    @else
                        <div class="empty-list">پرونده‌ی بازی نیست.</div>
                    @endif
                </section>
            @else
                <section class="card">
                    <h3>@icon('lock') اتاق‌های تحت اقدام</h3>
                    <div class="muted small">{{ $J->digits($rooms['held'] + $rooms['suspended'] + $rooms['watched']) }} اتاق</div>
                </section>
            @endcan

            <section class="card">
                <h3>@icon('shield') رویدادهای اخیر @if ($security['failed'])<span class="tag red">{{ $J->digits($security['failed']) }} ناموفق در ۲۴ ساعت</span>@endif<span class="spacer"></span>@can('audit.view')<a href="{{ route('panel.audit') }}">لاگ ممیزی</a>@endcan</h3>
                <ul class="feed">
                    @forelse ($security['recent'] as $l)
                        @php([$al, $ai, $at] = \App\Models\AdminLog::label($l->action))
                        <li><span class="fi {{ $at }}">@icon($ai)</span><span class="ft">{{ $al }}<small>{{ $l->email ?? 'سیستم' }}@if ($l->target) · <span class="ltr">{{ \Illuminate\Support\Str::limit($l->target, 24) }}</span>@endif</small></span><time>{{ $J->ago($l->created_at) }}</time></li>
                    @empty
                        <li class="muted">رویدادی ثبت نشده.</li>
                    @endforelse
                </ul>
            </section>
        </div>

        <section class="card">
            <h3>@icon('server') سلامت سرویس‌ها</h3>
            <div class="health">
                @forelse ($services as $s)
                    <div><div class="h-top"><span class="dot {{ $svcTone[$s->status] ?? '' }}"></span><b>{{ $s->name }}</b></div><small>{{ $s->detail ?: '—' }}</small><small class="faint">{{ $J->ago($s->checked_at) }}</small></div>
                @empty
                    <div><div class="h-top"><span class="dot"></span><b>بدون داده</b></div><small>هنوز بررسی‌ای انجام نشده.</small></div>
                @endforelse
                @foreach ($domains as $d)
                    <div><div class="h-top"><span class="dot {{ $d->status === 'active' ? 'ok' : 'warn' }}"></span><b class="ltr">{{ $d->name }}</b></div><small>SSL {{ $d->ssl_mode }} · TLS ≥ {{ $d->min_tls }}</small></div>
                @endforeach
            </div>
        </section>
    </div>
@endsection
