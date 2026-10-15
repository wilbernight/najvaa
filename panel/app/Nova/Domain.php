<?php

namespace App\Nova;

use App\Nova\Actions\EnforceSecureTls;
use App\Nova\Actions\RefreshDomains;
use Illuminate\Http\Request;
use Laravel\Nova\Fields\Badge;
use Laravel\Nova\Fields\DateTime;
use Laravel\Nova\Fields\Number;
use Laravel\Nova\Fields\Text;
use Laravel\Nova\Http\Requests\NovaRequest;

class Domain extends Resource
{
    public static $model = \App\Models\Domain::class;

    public static $title = 'name';

    public static $search = ['name'];

    public static function label(): string
    {
        return 'دامنه‌ها (Cloudflare)';
    }

    public static function singularLabel(): string
    {
        return 'دامنه';
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
        return false;
    }

    public function authorizedToReplicate(Request $request): bool
    {
        return false;
    }

    public function fields(NovaRequest $request): array
    {
        return [
            Text::make('دامنه', 'name')->sortable(),
            Badge::make('وضعیت', 'status')->map(['active' => 'success', 'pending' => 'warning'])->labels(['active' => 'فعال', 'pending' => 'در انتظار']),
            Badge::make('SSL', 'ssl_mode')
                ->map(['strict' => 'success', 'full' => 'warning', 'flexible' => 'danger', 'off' => 'danger'])
                ->labels(['strict' => 'Full (strict)', 'full' => 'Full', 'flexible' => 'Flexible ⚠', 'off' => 'خاموش ⚠']),
            Badge::make('HTTPS اجباری', 'always_https')->map(['on' => 'success', 'off' => 'warning'])->labels(['on' => 'روشن', 'off' => 'خاموش']),
            Text::make('حداقل TLS', 'min_tls'),
            Number::make('رکورد AAAA', 'aaaa_records'),
            Number::make('پروکسی‌شده', 'aaaa_proxied')->onlyOnDetail(),
            Badge::make('هماهنگ با IP سرور', fn () => $this->aaaa_stale ? 'stale' : 'ok')
                ->map(['ok' => 'success', 'stale' => 'info'])
                ->labels(['ok' => 'بله', 'stale' => "{$this->aaaa_stale} رکورد جای دیگر"]),
            DateTime::make('به‌روزرسانی', 'synced_at')->onlyOnDetail(),
        ];
    }

    public function actions(NovaRequest $request): array
    {
        return [
            RefreshDomains::make()->standalone(),
            EnforceSecureTls::make()->showInline(),
        ];
    }
}
