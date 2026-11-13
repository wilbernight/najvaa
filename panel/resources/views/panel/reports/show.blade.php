@extends('panel.layout')
@section('title', 'گزارش '.$report->remote_id)
@section('bodyClass', 'has-detail')

@php($R = \App\Models\AbuseReport::class)

@section('list')
    @include('panel.partials.report-list')
@endsection

@section('main')
    <header class="chat-head">
        <a class="icon-btn back-btn" href="{{ route('panel.reports', request()->only('f')) }}" aria-label="بازگشت">@icon('back')</a>
        <span class="av sm {{ $report->severe() ? 'red' : 't'.\App\Support\Icons::tone($report->code) }}">@icon('flag')</span>
        <div class="title">
            <b>{{ $R::REASONS[$report->reason] }} · اتاق {{ $J->digits($report->code) }}</b>
            <span>{{ $R::STATUSES[$report->status] }} · {{ $J->ago($report->received_at) }}</span>
        </div>
        <div class="head-actions">
            <button type="button" class="icon-btn hide-wide" data-toggle-info title="رسیدگی">@icon('more')</button>
        </div>
    </header>
    <div class="wall">
        <div class="day"><span>{{ $J->format($report->received_at, 'j F Y') }}</span></div>
        <div class="bubble">
            <div class="who">گزارش‌دهنده ناشناس</div>
            <div class="body">{{ $report->body ?: '(بدون توضیح)' }}</div>
            @if ($report->contact)<div class="small muted">راه تماس: <span class="ltr">{{ $report->contact }}</span></div>@endif
            <div class="meta"><span class="mono">#{{ $report->remote_id }}</span> · {{ $J->format($report->received_at, 'H:i') }}</div>
        </div>
        @if ($report->handled_at)
            <div class="bubble out">
                <div class="body">{{ $R::STATUSES[$report->status] }}@if ($report->resolution) — {{ $report->resolution }}@endif</div>
                <div class="meta">{{ $report->handler?->name }} · {{ $J->format($report->handled_at) }} @icon('checks')</div>
            </div>
        @endif
        @if ($others->isNotEmpty())
            <div class="bubble sys">این اتاق {{ $J->digits($others->count()) }} گزارش دیگر هم دارد:
                @foreach ($others as $o)<a href="{{ route('panel.reports.show', $o) }}"><b>{{ $R::REASONS[$o->reason] }}</b> ({{ $J->format($o->received_at, 'm/d') }})</a>@if (! $loop->last)، @endif @endforeach
            </div>
        @endif
    </div>
@endsection

@section('info')
    <div class="info-head">
        <span class="av lg {{ $report->severe() ? 'red' : 't'.\App\Support\Icons::tone($report->code) }}">@icon('flag')</span>
        <h2>اتاق {{ $J->digits($report->code) }}</h2>
        @if ($room)
            <a class="btn sm ghost" href="{{ route('panel.rooms.show', $room) }}">@icon('chat') باز کردن اتاق</a>
        @else
            <div class="muted small">این اتاق اکنون روی سرور نیست.</div>
        @endif
    </div>
    @can('reports.manage')
        <div class="info-sec">
            <h3>رسیدگی</h3>
            <form method="post" action="{{ route('panel.reports.update', $report) }}">@csrf
                <div class="field"><label>وضعیت</label>
                    <select class="input" name="status">@foreach ($R::STATUSES as $k => $l)<option value="{{ $k }}" @selected($report->status === $k)>{{ $l }}</option>@endforeach</select></div>
                <div class="field"><label>پیوست به پرونده</label>
                    <select class="input" name="legal_case_id"><option value="">—</option>@foreach ($openCases as $c)<option value="{{ $c->id }}" @selected($report->legal_case_id === $c->id)>{{ $c->ref }} — {{ \Illuminate\Support\Str::limit($c->subject, 30) }}</option>@endforeach</select></div>
                <div class="field"><label>نتیجه / توضیح</label><textarea class="input" name="resolution" maxlength="2000">{{ $report->resolution }}</textarea></div>
                <button class="btn sm">ذخیره</button>
            </form>
        </div>
        <div class="info-sec">
            <h3>اقدام سریع</h3>
            @if ($room)
                <a class="act danger" href="{{ route('panel.rooms.show', $room) }}">@icon('ban')<span>مسدود کردن یا توقیف اتاق<small>از صفحه‌ی اتاق</small></span></a>
            @endif
            @can('legal.manage')
                <a class="act good" href="{{ route('panel.cases.create', ['code' => $report->code]) }}">@icon('scale')<span>ثبت پرونده‌ی حقوقی برای این اتاق</span></a>
            @endcan
        </div>
    @endcan
@endsection
