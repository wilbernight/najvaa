@php($f = request('f', 'open'))
<div class="pane-head">
    <h1>پرونده‌های حقوقی</h1>
    @can('legal.manage')
        <a class="icon-btn" href="{{ route('panel.cases.create') }}" title="پرونده‌ی تازه">@icon('plus')</a>
    @endcan
</div>
<form class="search" method="get" action="{{ route('panel.cases') }}">
    @icon('search')
    <input type="hidden" name="f" value="{{ $f }}">
    <input name="q" value="{{ request('q') }}" autocomplete="off" placeholder="شماره، موضوع، مرجع یا کد اتاق…" data-filter=".rows .row">
</form>
<div class="chips">
    @foreach (['open' => 'باز', 'overdue' => 'سررسید گذشته', 'mine' => 'ارجاع به من', 'closed' => 'بسته', 'all' => 'همه'] as $k => $l)
        <a class="chip {{ $f === $k ? 'on' : '' }}" href="{{ route('panel.cases', ['f' => $k]) }}">{{ $l }}</a>
    @endforeach
</div>
<div class="rows">
    @forelse ($cases as $c)
        @php($od = $c->overdue())
        <a href="{{ route('panel.cases.show', ['case' => $c, 'f' => $f]) }}" class="row {{ isset($case) && $case->id === $c->id ? 'active' : '' }} {{ $c->isOpen() ? 'unread' : '' }}"
           data-search="{{ $c->ref }} {{ $c->subject }} {{ $c->rooms->pluck('code')->join(' ') }}">
            <span class="av {{ $c->priority === 'urgent' ? 'red' : ($od ? 'amber' : 't'.\App\Support\Icons::tone($c->ref)) }}">@icon('scale')</span>
            <span class="row-main">
                <span class="row-top">
                    <span class="row-title">{{ $c->subject }}</span>
                    <span class="row-time">{{ $J->short($c->updated_at) }}</span>
                </span>
                <span class="row-bot">
                    <span class="row-sub"><span class="mono">{{ $c->ref }}</span> · {{ \App\Models\LegalCase::KINDS[$c->kind] ?? $c->kind }}</span>
                    @if ($od)
                        <span class="badge red" title="سررسید گذشته">!</span>
                    @elseif ($c->isOpen())
                        <span class="badge {{ $c->status === 'received' ? '' : 'muted' }}">{{ \App\Models\LegalCase::STATUSES[$c->status] }}</span>
                    @endif
                </span>
            </span>
        </a>
    @empty
        <div class="empty-list">پرونده‌ای نیست.</div>
    @endforelse
</div>
@can('legal.manage')
    <a class="fab" href="{{ route('panel.cases.create') }}" title="پرونده‌ی تازه">@icon('plus')</a>
@endcan
