import type { MigrationDirection, RunMigrationsRequest } from '@sqlmal/contracts';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

const OUT_OF_RANGE_MESSAGE = 'steps or target out of range';

export class RunMigrationsRequestDto implements RunMigrationsRequest {
  @IsIn(['up', 'down'], { message: 'direction must be up or down' })
  direction!: MigrationDirection;

  @IsOptional()
  @IsInt({ message: OUT_OF_RANGE_MESSAGE })
  @Min(0, { message: OUT_OF_RANGE_MESSAGE })
  @Max(1000, { message: OUT_OF_RANGE_MESSAGE })
  steps?: number;

  @IsOptional()
  @IsInt({ message: OUT_OF_RANGE_MESSAGE })
  @Min(0, { message: OUT_OF_RANGE_MESSAGE })
  targetVersion?: number;

  @IsOptional()
  @IsBoolean()
  isDryRun?: boolean;

  @IsOptional()
  @IsBoolean()
  allowDriftedHistory?: boolean;
}
