@php($f = request('f', 'all'))
<div class="pane-head">
    <h1>اتاق‌ها</h1>
    <span class="badge muted">{{ $J->digits($rooms->count()) }}</span>
</div>
<form class="search" method="get" action="{{ route('panel.rooms.find') }}">
    @icon('search')
    <input name="code" inputmode="numeric" autocomplete="off" placeholder="جستجو یا یافتن با کد ۷ رقمی…" data-filter=".rows .row" aria-label="کد اتاق">
</form>
<div class="chips">
    @foreach (['all' => 'همه', 'online' => 'آنلاین', 'held' => 'توقیف', 'suspended' => 'مسدود', 'watched' => 'تحت پایش', 'big' => 'حجیم'] as $k => $l)
        <a class="chip {{ $f === $k ? 'on' : '' }}" href="{{ route('panel.rooms', ['f' => $k]) }}">{{ $l }}</a>
    @endforeach
</div>
<div class="rows">
    @forelse ($rooms as $r)
        @php($t = \App\Support\Icons::tone($r->room_id))
        <a href="{{ route('panel.rooms.show', array_filter(['room' => $r->room_id, 'f' => $f !== 'all' ? $f : null])) }}"
           class="row {{ isset($room) && $room->id === $r->id ? 'active' : '' }} {{ $r->online ? 'unread' : '' }}"
           data-search="{{ $r->code }} {{ $r->room_id }}">
            <span class="av t{{ $t }}">
                {{ $r->code ? $J->digits(substr($r->code, 0, 3)) : '؟' }}
                @if ($r->online)<i class="online-dot"></i>@endif
            </span>
            <span class="row-main">
                <span class="row-top">
                    <span class="row-title">{{ $r->code ? $J->digits($r->code) : 'در حال یافتن کد…' }}</span>
                    <span class="row-time">{{ $J->short($r->last_activity_at) }}</span>
                </span>
                <span class="row-bot">
                    <span class="row-sub">
                        @if ($r->online)
                            {{ $J->digits($r->online) }} دستگاه آنلاین ·
                        @endif
                        {{ $J->digits($r->items) }} مورد · {{ $J->bytes($r->bytes) }}
                    </span>
                    <span class="row-flags">
                        @if ($r->hold)<span class="flag hold" title="حفظ داده (توقیف)">@icon('lock')</span>@endif
                        @if ($r->suspended)<span class="flag suspend" title="مسدود">@icon('ban')</span>@endif
                        @if ($r->watched())<span class="flag watch" title="ثبت اتصال">@icon('eye')</span>@endif
                    </span>
                </span>
            </span>
        </a>
    @empty
        <div class="empty-list">اتاقی نیست.</div>
    @endforelse
</div>
