@extends('panel.layout')
@section('title', 'گزارش‌های تخلف')

@section('list')
    @include('panel.partials.report-list')
@endsection

@section('main')
    <div class="placeholder">
        <div>
            <div class="big">@icon('flag')</div>
            <h2>صف گزارش‌های تخلف</h2>
            <p>کاربران از صفحه‌ی <span class="mono">{{ rtrim(config('najva.chat_url'), '/') }}/report.html</span> با کد اتاق گزارش می‌دهند. گزارش‌های مربوط به کودکان، تروریسم و تهدید بالای صف می‌آیند.</p>
        </div>
    </div>
@endsection
