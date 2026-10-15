<?php

namespace App\Nova;

use App\Nova\Actions\DeleteRoom;
use App\Nova\Actions\KickRoom;
use App\Nova\Actions\RunJanitor;
use Illuminate\Contracts\Database\Eloquent\Builder;
use Illuminate\Http\Request;
use Laravel\Nova\Fields\Badge;
use Laravel\Nova\Fields\DateTime;
use Laravel\Nova\Fields\Number;
use Laravel\Nova\Fields\Text;
use Laravel\Nova\Http\Requests\NovaRequest;

class Room extends Resource
{
    public static $model = \App\Models\Room::class;

    public static $title = 'code';

    public static $search = ['code'];

    public static $perPageOptions = [25, 50, 100];

    public static function label(): string
    {
        return 'اتاق‌های چت';
    }

    public static function singularLabel(): string
    {
        return 'اتاق';
    }

    public static function authorizedToCreate(Request $request): bool
    {
        return false;
    }

    public function authorizedToUpdate(Request $request): bool
    {
        return false;
    }

    public function authorizedToReplicate(Request $request): bool
    {
        return false;
    }

    public function authorizedToDelete(Request $request): bool
    {
        return false; // deletion goes through the DeleteRoom action (relay + confirm)
    }

    public function fields(NovaRequest $request): array
    {
        return [
            Text::make('شماره اتاق', fn () => $this->code ?? 'در حال یافتن…')
                ->help('شماره‌ی ۷ رقمی از شناسه‌ی اتاق محاسبه می‌شود. رمز اتاق هرگز به سرور نمی‌رسد، پس محتوا همچنان خواندنی نیست.'),
            Text::make('شناسه', 'short_id')->onlyOnDetail(),
            Badge::make('وضعیت', fn () => $this->online > 0 ? 'online' : 'offline')
                ->map(['online' => 'success', 'offline' => 'info'])
                ->labels(['online' => "آنلاین ({$this->online} دستگاه)", 'offline' => 'آفلاین']),
            Number::make('دستگاه آنلاین', 'online')->sortable()->onlyOnDetail(),
            Number::make('موارد ذخیره‌شده', 'items')->sortable(),
            Number::make('فایل', 'files')->sortable(),
            Text::make('حجم', fn () => $this->humanBytes($this->bytes))->sortable(false),
            Number::make('بایت', 'bytes')->sortable()->onlyOnDetail(),
            DateTime::make('آخرین فعالیت', 'last_activity_at')->sortable(),
            DateTime::make('ایجاد', 'remote_created_at')->sortable()->onlyOnDetail(),
        ];
    }

    public function actions(NovaRequest $request): array
    {
        return [
            KickRoom::make()->showInline(),
            DeleteRoom::make()->showInline(),
            RunJanitor::make()->standalone(),
        ];
    }

    public static function indexQuery(NovaRequest $request, Builder $query): Builder
    {
        return empty($request->get('orderBy')) ? $query->orderByDesc('last_activity_at') : $query;
    }

    private function humanBytes(int $b): string
    {
        foreach (['بایت', 'کیلوبایت', 'مگابایت', 'گیگابایت'] as $i => $u) {
            if ($b < 1024 ** ($i + 1) || $i === 3) {
                return round($b / 1024 ** $i, $i ? 1 : 0).' '.$u;
            }
        }

        return (string) $b;
    }
}
