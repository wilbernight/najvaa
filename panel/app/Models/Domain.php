<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Laravel\Nova\Actions\Actionable;

class Domain extends Model
{
    use Actionable;

    protected $table = 'najva_domains';

    protected $guarded = [];

    protected function casts(): array
    {
        return ['synced_at' => 'datetime'];
    }
}
