@php($f = request('f', 'new'))
<div class="pane-head"><h1>گزارش‌های تخلف</h1></div>
<div class="search">
    @icon('search')
    <input autocomplete="off" placeholder="جستجو در کد اتاق یا شماره…" data-filter=".rows .row">
</div>
<div class="chips">
    @foreach (['new' => 'جدید', 'reviewing' => 'در حال بررسی', 'actioned' => 'اقدام شد', 'dismissed' => 'رد شد', 'all' => 'همه'] as $k => $l)
        <a class="chip {{ $f === $k ? 'on' : '' }}" href="{{ route('panel.reports', ['f' => $k]) }}">{{ $l }}</a>
    @endforeach
</div>
<div class="rows">
    @forelse ($reports as $r)
        <a href="{{ route('panel.reports.show', ['report' => $r, 'f' => $f]) }}" class="row {{ isset($report) && $report->id === $r->id ? 'active' : '' }} {{ $r->status === 'new' ? 'unread' : '' }}"
           data-search="{{ $r->code }} {{ $r->remote_id }}">
            <span class="av {{ $r->severe() ? 'red' : 't'.\App\Support\Icons::tone($r->code) }}">@icon('flag')</span>
            <span class="row-main">
                <span class="row-top">
                    <span class="row-title">{{ \App\Models\AbuseReport::REASONS[$r->reason] }}</span>
                    <span class="row-time">{{ $J->short($r->received_at) }}</span>
                </span>
                <span class="row-bot">
                    <span class="row-sub">اتاق {{ $J->digits($r->code) }} · {{ \Illuminate\Support\Str::limit((string) $r->body, 40) ?: 'بدون توضیح' }}</span>
                    @if ($r->status === 'new')<span class="badge {{ $r->severe() ? 'red' : '' }}">جدید</span>@endif
                </span>
            </span>
        </a>
    @empty
        <div class="empty-list">گزارشی نیست.</div>
    @endforelse
</div>
