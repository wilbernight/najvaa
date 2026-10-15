<?php

namespace App\Nova\Dashboards;

use App\Nova\Metrics\LiveRooms;
use App\Nova\Metrics\OnlineDevices;
use App\Nova\Metrics\RoomsBySize;
use App\Nova\Metrics\StorageTrend;
use App\Nova\Metrics\StorageUsage;
use App\Nova\Metrics\StoredRooms;
use Laravel\Nova\Dashboards\Main as Dashboard;

class Main extends Dashboard
{
    public function name(): string
    {
        return 'داشبورد';
    }

    public function cards(): array
    {
        return [
            OnlineDevices::make()->width('1/3'),
            LiveRooms::make()->width('1/3'),
            StoredRooms::make()->width('1/3'),
            StorageUsage::make()->width('1/3'),
            StorageTrend::make()->width('1/3')->defaultRange('7'),
            RoomsBySize::make()->width('1/3'),
        ];
    }
}
