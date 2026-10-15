<?php

namespace App\Nova\Actions;

use App\Models\AdminLog;
use App\Services\Relay;
use Illuminate\Support\Collection;
use Laravel\Nova\Actions\Action;
use Laravel\Nova\Actions\ActionResponse;
use Laravel\Nova\Fields\ActionFields;
use Laravel\Nova\Http\Requests\NovaRequest;
use Throwable;

class KickRoom extends Action
{
    public function name(): string
    {
        return 'قطع اتصال دستگاه‌ها';
    }

    public function __construct()
    {
        $this->confirmText('همه‌ی دستگاه‌های وصل به این اتاق قطع می‌شوند. پیام‌ها پاک نمی‌شوند.')
            ->confirmButtonText('قطع اتصال')
            ->cancelButtonText('انصراف');
    }

    public function fields(NovaRequest $request): array
    {
        return [];
    }

    public function handle(ActionFields $fields, Collection $models)
    {
        $total = 0;
        foreach ($models as $room) {
            try {
                $total += app(Relay::class)->kickRoom($room->room_id);
            } catch (Throwable) {
                return ActionResponse::danger('سرویس چت پاسخ نداد.');
            }
            AdminLog::record('room.kicked', $room->code ?? $room->short_id);
        }

        return ActionResponse::message("{$total} دستگاه قطع شد.");
    }
}
