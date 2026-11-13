@extends('panel.layout')
@section('title', 'گزارش شفافیت')

@php
    $max = max(1, $byKind->max(), $byStatus->max(), $reportsByReason->max());
@endphp

@section('main')
    <div class="page">
        <div class="page-head">
            <h1>گزارش شفافیت</h1>
            <a class="btn sm ghost" href="{{ route('panel.transparency.csv', ['y' => $year, 'h' => $half]) }}">@icon('download') CSV</a>
            <p>شمار درخواست‌های مراجع و گزارش‌های تخلف در بازه‌ی {{ $J->format($from, 'j F Y') }} تا {{ $J->format($to, 'j F Y') }}. فقط شمارش، بدون نام یا جزئیات.</p>
        </div>
        <form class="btn-row" method="get">
            <select class="input" name="y">@for ($y = $J->year(now()); $y >= 1403; $y--)<option value="{{ $y }}" @selected($y === $year)>{{ $J->digits($y) }}</option>@endfor</select>
            <select class="input" name="h"><option value="all" @selected($half === 'all')>کل سال</option><option value="1" @selected($half === '1')>نیمه‌ی اول</option><option value="2" @selected($half === '2')>نیمه‌ی دوم</option></select>
            <button class="btn sm">نمایش</button>
        </form>
        <div class="grid mt">
            <div class="card stat"><span class="av t3">@icon('scale')</span><div><div class="num">{{ $J->digits($total) }}</div><div class="lbl">درخواست مرجع</div></div></div>
            <div class="card stat"><span class="av t6">@icon('chat')</span><div><div class="num">{{ $J->digits($rooms) }}</div><div class="lbl">اتاق درگیر</div></div></div>
            <div class="card stat"><span class="av t2">@icon('flag')</span><div><div class="num">{{ $J->digits($reports) }}</div><div class="lbl">گزارش تخلف</div></div></div>
        </div>
        <div class="grid two mt">
            @foreach ([['بر اساس نوع درخواست', $byKind, \App\Models\LegalCase::KINDS], ['نتیجه‌ی درخواست‌ها', $byStatus, \App\Models\LegalCase::STATUSES], ['گزارش‌ها بر اساس دلیل', $reportsByReason, \App\Models\AbuseReport::REASONS]] as [$title, $set, $labels])
                <div class="card">
                    <h3>{{ $title }}</h3>
                    @foreach ($set as $k => $n)
                        <div class="kv"><div><b>{{ $labels[$k] }}</b>@include('panel.partials.bar', ['pct' => $n / $max * 100])</div><b>{{ $J->digits($n) }}</b></div>
                    @endforeach
                </div>
            @endforeach
            <div class="card">
                <h3>آنچه هرگز در دسترس نیست</h3>
                <p class="muted">محتوای پیام‌ها، فایل‌ها و تماس‌ها روی دستگاه کاربران رمز می‌شود و سرور هیچ کلیدی ندارد؛ بنابراین در هیچ درخواستی محتوا افشا نشده و نمی‌شود. نجوا حساب کاربری، شماره یا ایمیل ندارد. ثبت اتصال فقط برای اتاق‌های مشخص، با پرونده و برای مدت محدود انجام می‌شود.</p>
            </div>
        </div>
    </div>
@endsection
