@extends('panel.layout')
@section('title', 'اتاق‌ها')

@section('list')
    @include('panel.partials.room-list')
@endsection

@section('main')
    <div class="placeholder">
        <div>
            <div class="big">@icon('chat')</div>
            <h2>یک اتاق را انتخاب کنید</h2>
            <p>یا کد ۷ رقمی اتاق را در جستجو بزنید و Enter را بفشارید تا حتی اگر در فهرست نیست، پیدا شود.</p>
            <div class="e2e-note">@icon('lock') محتوای همه‌ی گفتگوها رمزنگاری سرتاسری است؛ این پنل فقط زمان، حجم و پرچم‌ها را می‌بیند.</div>
        </div>
    </div>
@endsection
