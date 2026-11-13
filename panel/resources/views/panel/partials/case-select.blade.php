@if ($caseOptions->isEmpty())
    <div class="alert-box warn">@icon('alert')<div>
        پرونده‌ی بازی نیست. {{ $required ? 'این کار فقط با استناد به یک پرونده‌ی حقوقی ممکن است.' : '' }}
        @can('legal.manage')<a href="{{ route('panel.cases.create', ['code' => $room->code ?? '']) }}"><b>ثبت پرونده‌ی تازه</b></a>@endcan
    </div></div>
@else
    <div class="field">
        <label>پرونده {{ $required ? '(الزامی)' : '(اختیاری)' }}</label>
        <select class="input" name="case_id" @required($required)>
            @unless ($required)<option value="">—</option>@endunless
            @foreach ($caseOptions as $c)
                <option value="{{ $c['id'] }}">{{ $c['label'] }}</option>
            @endforeach
        </select>
    </div>
@endif
