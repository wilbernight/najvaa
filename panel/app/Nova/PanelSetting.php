<?php

namespace App\Nova;

use Illuminate\Http\Request;
use Laravel\Nova\Fields\Boolean;
use Laravel\Nova\Fields\DateTime;
use Laravel\Nova\Fields\Heading;
use Laravel\Nova\Fields\Number;
use Laravel\Nova\Http\Requests\NovaRequest;

class PanelSetting extends Resource
{
    public static $model = \App\Models\PanelSetting::class;

    public static $title = 'id';

    public static $search = [];

    public static $globallySearchable = false;

    public static function label(): string
    {
        return 'تنظیمات چت';
    }

    public static function singularLabel(): string
    {
        return 'تنظیمات';
    }

    public static function authorizedToCreate(Request $request): bool
    {
        return false;
    }

    public function authorizedToDelete(Request $request): bool
    {
        return false;
    }

    public function authorizedToReplicate(Request $request): bool
    {
        return false;
    }

    public function fields(NovaRequest $request): array
    {
        return [
            Heading::make('فضای ذخیره و پاک‌سازی خودکار'),
            Number::make('سقف کل حجم سرور (گیگابایت)', 'cap_gb')
                ->min(1)->max(500)->step(1)->rules('required', 'integer', 'between:1,500')
                ->help('اگر کل حجم از این بیشتر شود، قدیمی‌ترین محتوا اول پاک می‌شود.'),
            Number::make('مدت نگه‌داری (روز)', 'max_days')
                ->min(1)->max(3650)->step(1)->rules('required', 'integer', 'between:1,3650')
                ->help('محتوای قدیمی‌تر از این خودکار پاک می‌شود.'),

            Heading::make('قابلیت‌ها'),
            Boolean::make('ساخت اتاق جدید', 'new_rooms')->help('خاموش: فقط اتاق‌های موجود کار می‌کنند.'),
            Boolean::make('تماس صوتی', 'calls'),
            Boolean::make('جستجو و ارسال GIF', 'gif'),
            Boolean::make('پیش‌نمایش لینک اینستاگرام', 'preview'),

            DateTime::make('آخرین تغییر', 'updated_at')->exceptOnForms(),
        ];
    }
}
