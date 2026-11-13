@extends('panel.layout')
@section('title', 'پرونده‌ها')

@section('list')
    @include('panel.partials.case-list')
@endsection

@section('main')
    <div class="placeholder">
        <div>
            <div class="big">@icon('scale')</div>
            <h2>پاسخگویی قضایی</h2>
            <p>هر درخواست مرجع قضایی یا انتظامی را به‌صورت یک پرونده ثبت کنید: اتاق‌های مرتبط، توقیف داده، پایش اتصال، بسته‌ی افشا و همه‌ی اقدام‌ها با زمان و نام انجام‌دهنده در تاریخچه‌ی پرونده می‌ماند.</p>
            @can('legal.manage')
                <p><a class="btn" href="{{ route('panel.cases.create') }}">@icon('plus') ثبت پرونده‌ی تازه</a></p>
            @endcan
        </div>
    </div>
@endsection
