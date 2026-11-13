@extends('panel.layout')
@section('title', 'پرونده‌ی تازه')
@section('bodyClass', 'has-detail')

@section('list')
    @include('panel.partials.case-list')
@endsection

@section('main')
    <header class="chat-head">
        <a class="icon-btn back-btn" href="{{ route('panel.cases') }}" aria-label="بازگشت">@icon('back')</a>
        <span class="av sm green">@icon('plus')</span>
        <div class="title"><b>ثبت درخواست قضایی / انتظامی</b><span>شماره‌ی داخلی پس از ثبت داده می‌شود</span></div>
    </header>
    <div class="page">
        <form method="post" action="{{ route('panel.cases.store') }}" class="card" autocomplete="off">
            @csrf
            <div class="row2">
                <div class="field">
                    <label>نوع درخواست</label>
                    <select class="input" name="kind" required>
                        @foreach (\App\Models\LegalCase::KINDS as $k => $l)
                            <option value="{{ $k }}" @selected(old('kind') === $k)>{{ $l }}</option>
                        @endforeach
                    </select>
                </div>
                <div class="field">
                    <label>اولویت</label>
                    <select class="input" name="priority" required>
                        @foreach (\App\Models\LegalCase::PRIORITIES as $k => $l)
                            <option value="{{ $k }}" @selected(old('priority', 'normal') === $k)>{{ $l }}</option>
                        @endforeach
                    </select>
                </div>
            </div>
            <div class="row2">
                <div class="field"><label>مرجع درخواست‌کننده</label><input class="input" name="authority" required maxlength="300" value="{{ old('authority') }}" placeholder="مثلاً دادسرای عمومی و انقلاب تهران، شعبه‌ی …"></div>
                <div class="field"><label>شماره‌ی نامه / دستور</label><input class="input" name="authority_ref" maxlength="120" value="{{ old('authority_ref') }}"></div>
            </div>
            <div class="field"><label>موضوع</label><input class="input" name="subject" required maxlength="300" value="{{ old('subject') }}"></div>
            <div class="field"><label>شرح درخواست</label><textarea class="input" name="description" maxlength="10000">{{ old('description') }}</textarea></div>
            <div class="row2">
                <div class="field"><label>تاریخ دریافت</label><input class="input" name="received_on" required value="{{ old('received_on', $J->latin($J->format(now(), 'Y/m/d'))) }}" placeholder="۱۴۰۵/۰۸/۲۲" inputmode="numeric"></div>
                <div class="field"><label>مهلت پاسخ</label><input class="input" name="due_on" value="{{ old('due_on') }}" placeholder="۱۴۰۵/۰۹/۰۱" inputmode="numeric"><span class="hint">تاریخ شمسی؛ پرونده‌های گذشته از مهلت قرمز می‌شوند.</span></div>
            </div>
            <div class="row2">
                <div class="field"><label>کد اتاق‌ها</label><input class="input" name="codes" value="{{ old('codes', $prefillCode) }}" placeholder="۱۲۳۴۵۶۷، ۷۶۵۴۳۲۱" inputmode="numeric"><span class="hint">چند کد را با فاصله یا ویرگول جدا کنید.</span></div>
                <div class="field">
                    <label>مسئول پرونده</label>
                    <select class="input" name="assignee_id">
                        <option value="">—</option>
                        @foreach ($users as $u)
                            <option value="{{ $u->id }}" @selected((int) old('assignee_id', auth()->id()) === $u->id)>{{ $u->name }} ({{ $u->roleLabel() }})</option>
                        @endforeach
                    </select>
                </div>
            </div>
            <div class="alert-box">@icon('lock')<div>مرجع، شماره‌ی نامه، موضوع، شرح و یادداشت‌ها با کلید پنل رمزشده ذخیره می‌شوند.</div></div>
            <div class="btn-row"><button class="btn">@icon('check') ثبت پرونده</button><a class="btn ghost" href="{{ route('panel.cases') }}">انصراف</a></div>
        </form>
    </div>
@endsection
