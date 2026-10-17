import type { CreateMigrationRequest } from '@sqlmal/contracts';
import { IsOptional, IsString, MaxLength } from 'class-validator';

const MAX_SQL_LENGTH = 1_000_000;

export class CreateMigrationRequestDto implements CreateMigrationRequest {
  /** Checked by the domain, which says what a valid name looks like. */
  @IsString()
  name = '';

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SQL_LENGTH)
  upSql?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SQL_LENGTH)
  downSql?: string;
}
