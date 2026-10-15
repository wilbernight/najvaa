<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('najva_rooms', function (Blueprint $table) {
            $table->string('code', 7)->nullable()->index()->after('room_id');
        });
    }

    public function down(): void
    {
        Schema::table('najva_rooms', function (Blueprint $table) {
            $table->dropColumn('code');
        });
    }
};
