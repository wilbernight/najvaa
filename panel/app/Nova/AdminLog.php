<?php

namespace App\Nova;

use Illuminate\Contracts\Database\Eloquent\Builder;
use Illuminate\Http\Request;
use Laravel\Nova\Fields\BelongsTo;
use Laravel\Nova\Fields\Code;
use Laravel\Nova\Fields\DateTime;
use Laravel\Nova\Fields\Text;
use Laravel\Nova\Http\Requests\NovaRequest;

class AdminLog extends Resource
{
    public static $model = \App\Models\AdminLog::class;

    public static $title = 'action';

    public static $search = ['action', 'email', 'target'];

    public static function label(): string
    {
        return 'گزارش امنیتی';
    }

    public static function singularLabel(): string
    {
        return 'رویداد';
    }

    public static function authorizedToCreate(Request $request): bool
    {
        return false;
    }

    public function authorizedToUpdate(Request $request): bool
    {
        return false;
    }

    public function authorizedToDelete(Request $request): bool
    {
        return false; // the audit trail can't be edited from the panel
    }

    public function authorizedToReplicate(Request $request): bool
    {
        return false;
    }

    public function fields(NovaRequest $request): array
    {
        $labels = [
            'login' => 'ورود', 'login.failed' => 'ورود ناموفق', 'logout' => 'خروج', 'lockout' => 'قفل موقت ورود',
            'settings.updated' => 'تغییر تنظیمات', 'room.deleted' => 'حذف اتاق', 'room.kicked' => 'قطع اتصال اتاق',
            'store.janitor' => 'اجرای پاک‌سازی', 'domains.tls' => 'تنظیم امنیت دامنه', 'password.changed' => 'تغییر رمز',
        ];

        return [
            DateTime::make('زمان', 'created_at')->sortable(),
            Text::make('رویداد', fn () => $labels[$this->action] ?? $this->action),
            Text::make('کاربر', 'email'),
            Text::make('مورد', 'target'),
            Text::make('IP', 'ip')->onlyOnDetail(),
            BelongsTo::make('حساب', 'user', User::class)->onlyOnDetail()->nullable(),
            Code::make('جزئیات', 'detail')->json()->onlyOnDetail(),
        ];
    }

    public static function indexQuery(NovaRequest $request, Builder $query): Builder
    {
        return empty($request->get('orderBy')) ? $query->orderByDesc('created_at') : $query;
    }
}
