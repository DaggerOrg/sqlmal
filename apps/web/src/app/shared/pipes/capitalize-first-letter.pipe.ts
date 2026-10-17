import { Pipe, type PipeTransform } from '@angular/core';
import { capitalizeFirstLetter } from '../../core/format';

@Pipe({ name: 'capitalizeFirstLetter' })
export class CapitalizeFirstLetterPipe implements PipeTransform {
  transform(text: string): string {
    return capitalizeFirstLetter(text);
  }
}
