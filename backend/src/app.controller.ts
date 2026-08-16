import { Controller, Get } from '@nestjs/common'; //decorateurs
import { AppService } from './app.service';

@Controller() // cette classe est un controller, elle va gérer les requêtes entrantes et renvoyer les réponses au client , controller() : gere les routes qui commencent par / (racine) , controller('cats') : gere les routes qui commencent par /cats
export class AppController {
  constructor(private readonly appService: AppService) {} //Le constructeur — injection de dépendances , pas besoin de faire new AppService()
//readonly : au lieu de this.appService = appService , this.appService est immutable
  @Get() //cette méthode va gérer les requêtes GET sur la route racine /
  getHello(): string {
    return this.appService.getHello(); //deleguer la logique métier au service => le controller ne fait que déléguer la logique métier au service
  }
}
