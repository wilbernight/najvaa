@extends('panel.layout')
@section('title', $case->ref)
@section('bodyClass', 'has-detail')

@php
    use App\Models\LegalCase;
    $statusTone = ['received' => '', 'review' => 'amber', 'in_progress' => 'blue', 'fulfilled' => 'green', 'partial' => 'green', 'rejected' => 'red', 'closed' => ''];
    $evLabel = function ($e) use ($J) {
        $m = $e->meta ?? [];
        $room = isset($m['room']) ? 'اتاق '.$J->digits($m['room']) : '';
        return match ($e->kind) {
            'status' => isset($m['from']) ? 'وضعیت: '.(LegalCase::STATUSES[$m['from']] ?? $m['from']).' ← '.(LegalCase::STATUSES[$m['status']] ?? $m['status']) : 'پرونده ثبت شد',
            'room' => ! empty($m['removed']) ? "{$room} از پرونده جدا شد" : "{$room} به پرونده افزوده شد".(isset($m['exists']) && ! $m['exists'] ? ' (روی سرور یافت نشد)' : ''),
            'hold' => "حفظ داده (توقیف) {$room} فعال شد",
            'release' => "حفظ داده {$room} برداشته شد",
            'suspend' => "{$room} مسدود شد",
            'unsuspend' => "مسدودی {$room} برداشته شد",
            'watch' => "ثبت اتصال‌های {$room} تا ".$J->format($m['until'] ?? null).' فعال شد',
            'unwatch' => "ثبت اتصال‌های {$room} متوقف شد",
            'export' => ! empty($m['download']) ? 'بسته‌ی افشا دانلود شد' : "بسته‌ی افشای {$room} ساخته شد".(! empty($m['content']) ? ' (همراه فایل‌های رمزشده)' : ''),
            'report' => 'گزارش تخلف پیوست شد',
            default => null,
        };
    };
    $pw = session('panel.export_password');
@endphp

@section('list')
    @include('panel.partials.case-list', ['cases' => $cases])
@endsection

@section('main')
    <header class="chat-head">
        <a class="icon-btn back-btn" href="{{ route('panel.cases', request()->only('f')) }}" aria-label="بازگشت">@icon('back')</a>
        <span class="av sm {{ $case->priority === 'urgent' ? 'red' : 't'.\App\Support\Icons::tone($case->ref) }}">@icon('scale')</span>
        <div class="title">
            <b>{{ $case->subject }}</b>
            <span><span class="mono">{{ $case->ref }}</span> · {{ LegalCase::STATUSES[$case->status] }}@if ($case->due_on) · مهلت {{ $J->format($case->due_on, 'Y/m/d') }}@endif</span>
        </div>
        <div class="head-actions">
            <button type="button" class="icon-btn hide-wide" data-toggle-info title="جزئیات پرونده">@icon('more')</button>
        </div>
    </header>

    <div class="wall" data-bottom>
        @if ($pw)
            <div class="bubble sys alert">
                <b>رمز بسته‌ی #{{ $J->digits($pw['id']) }}</b> — فقط همین یک بار نمایش داده می‌شود و هیچ‌جا ذخیره نمی‌شود. آن را جدا از فایل به مرجع بدهید:
                <div class="secret" data-copy="{{ $pw['password'] }}" title="برای کپی کلیک کنید">{{ $pw['password'] }}</div>
            </div>
        @endif
        @if ($case->overdue())
            <div class="bubble sys alert">مهلت پاسخ این پرونده ({{ $J->format($case->due_on, 'j F Y') }}) گذشته است.</div>
        @endif
        <div class="bubble">
            <div class="who">{{ $case->authority }}</div>
            @if ($case->authority_ref)<div class="small muted">نامه‌ی شماره‌ی <span class="mono">{{ $case->authority_ref }}</span></div>@endif
            <div class="body">{{ $case->description ?: $case->subject }}</div>
            <div class="meta">{{ LegalCase::KINDS[$case->kind] }} · دریافت {{ $J->format($case->received_on, 'Y/m/d') }}</div>
        </div>
        @foreach ($days as $day => $events)
            <div class="day"><span>{{ $day }}</span></div>
            @foreach ($events as $e)
                @php($sys = $evLabel($e))
                @if ($e->kind === 'note')
                    <div class="bubble {{ $e->user_id === auth()->id() ? 'out' : '' }}">
                        @if ($e->user_id !== auth()->id())<div class="who">{{ $e->user?->name ?? 'سیستم' }}</div>@endif
                        <div class="body">{{ $e->body }}</div>
                        <div class="meta">{{ $J->format($e->created_at, 'H:i') }} @icon('checks')</div>
                    </div>
                @else
                    <div class="bubble sys">
                        {{ $sys }}@if ($e->body) — {{ $e->body }}@endif
                        <div class="small faint">{{ $e->user?->name ?? 'سیستم' }} · {{ $J->format($e->created_at, 'H:i') }}</div>
                    </div>
                @endif
            @endforeach
        @endforeach
        <div id="end"></div>
    </div>

    @can('legal.manage')
        <form class="composer" method="post" action="{{ route('panel.cases.note', $case) }}">
            @csrf
            <textarea name="body" rows="1" maxlength="5000" required placeholder="یادداشت پرونده… (Ctrl+Enter برای ثبت)"></textarea>
            <button class="send-btn" title="ثبت یادداشت">@icon('send')</button>
        </form>
    @endcan
@endsection

@section('info')
    <div class="info-head">
        <span class="av lg {{ $case->priority === 'urgent' ? 'red' : 't'.\App\Support\Icons::tone($case->ref) }}">@icon('scale')</span>
        <h2 class="mono">{{ $case->ref }}</h2>
        <div class="btn-row center">
            <span class="tag {{ $statusTone[$case->status] ?? '' }}">{{ LegalCase::STATUSES[$case->status] }}</span>
            <span class="tag">{{ LegalCase::PRIORITIES[$case->priority] }}</span>
        </div>
    </div>

    <div class="info-sec">
        <h3>اتاق‌های پرونده</h3>
        @forelse ($case->rooms as $l)
            <div class="row">
                <a class="av sm t{{ \App\Support\Icons::tone($l->room_id) }}" href="{{ $l->room ? route('panel.rooms.show', $l->room) : '#' }}">{{ $J->digits(substr($l->label, 0, 3)) }}</a>
                <a class="row-main" href="{{ $l->room ? route('panel.rooms.show', $l->room) : '#' }}">
                    <span class="row-title">{{ $J->digits($l->label) }}</span>
                    <span class="row-sub">
                        @if (! $l->room) روی سرور نیست
                        @else {{ $J->digits($l->room->items) }} مورد · {{ $J->bytes($l->room->bytes) }}
                        @endif
                    </span>
                </a>
                <span class="row-flags">
                    @if ($l->room?->hold)<span class="flag hold" title="توقیف">@icon('lock')</span>@endif
                    @if ($l->room?->suspended)<span class="flag suspend" title="مسدود">@icon('ban')</span>@endif
                    @if ($l->room?->watched())<span class="flag watch" title="پایش">@icon('eye')</span>@endif
                </span>
                @can('legal.manage')
                    <form method="post" action="{{ route('panel.cases.rooms.detach', [$case, $l]) }}" data-confirm="این اتاق از پرونده جدا شود؟">@csrf
                        <button class="icon-btn" title="جدا کردن">@icon('x')</button>
                    </form>
                @endcan
            </div>
        @empty
            <div class="muted small">هنوز اتاقی افزوده نشده.</div>
        @endforelse
        @can('legal.manage')
            <form method="post" action="{{ route('panel.cases.rooms.attach', $case) }}" class="btn-row mt-s">@csrf
                <input class="input grow" name="code" required inputmode="numeric" placeholder="کد ۷ رقمی اتاق">
                <button class="btn sm">@icon('plus') افزودن</button>
            </form>
        @endcan
    </div>

    @can('legal.export')
        <div class="info-sec">
            <h3>بسته‌ی افشای اطلاعات</h3>
            @if ($case->rooms->isNotEmpty())
                <form method="post" action="{{ route('panel.exports.store', $case) }}">@csrf
                    <div class="field">
                        <label>اتاق</label>
                        <select class="input" name="link_id">
                            @foreach ($case->rooms as $l)<option value="{{ $l->id }}">{{ $J->digits($l->label) }}</option>@endforeach
                        </select>
                    </div>
                    <label class="check"><input type="checkbox" name="with_content" value="1"> همراه فایل‌های ذخیره‌شده (رمزشده و غیرقابل خواندن)</label>
                    <button class="btn sm">@icon('archive') ساخت بسته‌ی امضاشده</button>
                    <div class="hint small faint">ZIP رمزدار (AES-256) با فهرست مشخصات، زمان‌ها، ثبت اتصال‌ها، SHA256SUMS و امضا. {{ $J->digits(config('najva.export_days', 7)) }} روز نگه داشته می‌شود.</div>
                </form>
            @else
                <div class="muted small">برای ساخت بسته، نخست اتاقی به پرونده بیفزایید.</div>
            @endif
            @foreach ($case->exports as $x)
                <div class="kv">
                    @icon('archive')
                    <div>
                        <b>#{{ $J->digits($x->id) }} · اتاق {{ $J->digits($x->code ?? substr($x->room_id, 0, 8)) }} {{ $x->with_content ? '· با محتوا' : '' }}</b>
                        <small>{{ $J->format($x->created_at) }} · {{ $x->creator?->name }} · {{ $J->bytes($x->bytes) }} · {{ $J->digits($x->downloads) }} دانلود</small>
                        <small class="mono" title="SHA-256">{{ substr((string) $x->sha256, 0, 16) }}…</small>
                    </div>
                    @if ($x->available())
                        <a class="icon-btn" href="{{ route('panel.exports.download', $x) }}" title="دانلود">@icon('download')</a>
                    @else
                        <span class="tag">منقضی</span>
                    @endif
                </div>
            @endforeach
        </div>
    @endcan

    @can('legal.manage')
        <div class="info-sec">
            <h3>وضعیت و ارجاع</h3>
            <form method="post" action="{{ route('panel.cases.update', $case) }}">@csrf
                <div class="row2">
                    <div class="field"><label>وضعیت</label>
                        <select class="input" name="status">@foreach (LegalCase::STATUSES as $k => $l)<option value="{{ $k }}" @selected($case->status === $k)>{{ $l }}</option>@endforeach</select></div>
                    <div class="field"><label>اولویت</label>
                        <select class="input" name="priority">@foreach (LegalCase::PRIORITIES as $k => $l)<option value="{{ $k }}" @selected($case->priority === $k)>{{ $l }}</option>@endforeach</select></div>
                </div>
                <div class="row2">
                    <div class="field"><label>مسئول</label>
                        <select class="input" name="assignee_id"><option value="">—</option>@foreach ($users as $u)<option value="{{ $u->id }}" @selected($case->assignee_id === $u->id)>{{ $u->name }}</option>@endforeach</select></div>
                    <div class="field"><label>مهلت</label><input class="input" name="due_on" value="{{ $case->due_on ? $J->latin($J->format($case->due_on, 'Y/m/d')) : '' }}" inputmode="numeric" placeholder="۱۴۰۵/۰۹/۰۱"></div>
                </div>
                <div class="field"><label>توضیح تغییر وضعیت</label><input class="input" name="status_note" maxlength="300"></div>
                <button class="btn sm">ذخیره</button>
            </form>
        </div>
    @endcan

    <div class="info-sec">
        <h3>مشخصات</h3>
        <div class="kv">@icon('scale')<div><b>{{ $case->authority }}</b><small>مرجع</small></div></div>
        @if ($case->authority_ref)<div class="kv">@icon('file')<div><b class="mono">{{ $case->authority_ref }}</b><small>شماره‌ی نامه / دستور</small></div></div>@endif
        <div class="kv">@icon('clock')<div><b>{{ $J->format($case->received_on, 'j F Y') }}</b><small>دریافت</small></div></div>
        <div class="kv">@icon('users')<div><b>{{ $case->assignee?->name ?? '—' }}</b><small>مسئول · ثبت توسط {{ $case->creator?->name ?? '—' }}</small></div></div>
        @if ($case->closed_at)<div class="kv">@icon('check')<div><b>{{ $J->format($case->closed_at) }}</b><small>بسته شد</small></div></div>@endif
    </div>
@endsection
