import { Injectable } from '@nestjs/common';

@Injectable() //cette classe peut etre injectée dans d'autres classes (ex: controller) , elle va contenir la logique métier de l'application
export class AppService {
  getHello(): string {
    return 'Hello World!';
  }
}
