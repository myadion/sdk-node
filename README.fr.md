# Bibliothèque Node.js MyAdion

La bibliothèque Node.js officielle de l'API [Adion Cloud](https://myadion.com) : encaisser par carte avec **Adion Pay**, envoyer des **SMS**, et appeler toute autre route de l'API.

[English version](README.md)

- Node.js 18 ou plus récent, sans dépendance (`fetch` et `crypto` intégrés)
- Types TypeScript inclus, modules ES et CommonJS
- Obtient et renouvelle seule son jeton d'accès (OAuth `client_credentials`)
- Réessaie sans risque les appels limités ou en échec, avec un `Idempotency-Key` automatique là où l'API l'accepte
- Erreurs typées, avec les messages de validation champ par champ
- Vérification de la signature des webhooks
- Pagination à la demande avec `for await`

## Installation

```bash
npm install @myadion/sdk
```

## Identifiants

Dans l'espace client, ouvrez **Mon compte › Applications** et créez une application de type **serveur** avec les scopes utiles : `pay.session.write` (créer des sessions), `pay.payment.read` (relire sessions et paiements), `pay.refund.write` (rembourser), `pay.webhook.manage` (gérer les webhooks), `sms.message.send` (envoyer des SMS), `sms.service.read` (relire un SMS).

L'identifiant et le secret restent sur votre serveur. Jamais dans un navigateur ni dans une application mobile.

## Utilisation

```ts
import { MyAdion } from '@myadion/sdk'
// ou : const { MyAdion } = require('@myadion/sdk')

const myadion = new MyAdion({
  clientId: process.env.MYADION_CLIENT_ID,
  clientSecret: process.env.MYADION_CLIENT_SECRET,
  // project: 'project_AbCdEf123456', // si l'application couvre plusieurs projets
})

const session = await myadion.pay.sessions.create(
  {
    amount_cents: 4990, // 49,90 € TTC
    description: 'Commande n° 4521',
    reference: 'CMD-4521',
    success_url: 'https://boutique.exemple.fr/commande/4521/merci',
    cancel_url: 'https://boutique.exemple.fr/panier',
  },
  { idempotencyKey: 'commande-4521' },
)

res.redirect(303, session.url)
```

Payé, l'acheteur revient sur `success_url?session_id=pay_sess_…`. Ce retour ne prouve rien : attendez le webhook `payment.succeeded`, ou relisez la session.

#### Formulaire de paiement intégré

Pour garder l'acheteur sur votre page, créez la session avec `ui_mode: 'embedded'`. Elle n'a pas d'`url`, mais un `client_secret` à elle que votre page passe au script d'Adion ; le formulaire de carte vit dans une iframe servie par `pay.adioncloud.com`, les données de carte ne passent jamais par votre page. `return_url` remplace `success_url` et `cancel_url`. Déclarez d'abord l'origine de votre page (espace client › compte Pay › onglet Intégration).

```ts
const session = await myadion.pay.sessions.create({
  amount_cents: 4990,
  description: 'Commande 4521',
  reference: 'CMD-4521',
  ui_mode: 'embedded',
  return_url: 'https://boutique.example.com/commande/4521/merci',
})
res.json({ clientSecret: session.client_secret })
```

```html
<div id="paiement"></div>
<script src="https://pay.adioncloud.com/v1/adion-pay.js"></script>
<script type="module">
  const { clientSecret } = await (await fetch('/paiement/session', { method: 'POST' })).json()
  const checkout = await AdionPay().initEmbeddedCheckout({ clientSecret, onComplete: () => location.assign('/commande/4521/merci') })
  checkout.mount('#paiement')
</script>
```

Le `client_secret` n'ouvre que cette session, et expire avec elle. Comme pour la redirection, `onComplete` ne prouve rien : le webhook `payment.succeeded` fait foi.


```ts
// Tous les paiements, page après page
for await (const payment of myadion.pay.payments.list({ status: 'succeeded' })) {
  console.log(payment.id, payment.amount_cents)
}

// Rembourser (tout le reste sans amount_cents)
await myadion.pay.refunds.create('pay_pmt_AbCdEf123456', { amount_cents: 1000, reason: 'Article manquant' })

// Envoyer un SMS
await myadion.sms.send({ service_id: 'service_AbCdEf123456', to: '+33612345678', message: 'Votre code : 482913', type: 'transactional' })

// Toute autre route
await myadion.request('GET', '/account/pay')
```

Les adresses de webhook (`myadion.pay.webhookEndpoints`) et toutes les options sont décrites dans le [README anglais](README.md).

## Webhooks

Vérifiez la signature sur le corps **brut** :

```ts
app.post('/webhooks/adion-pay', express.raw({ type: 'application/json' }), (req, res) => {
  let event
  try {
    event = MyAdion.webhooks.constructEvent(req.body, req.get('Adion-Signature'), process.env.MYADION_WEBHOOK_SECRET)
  } catch {
    return res.sendStatus(400)
  }
  if (event.type === 'payment.succeeded') {
    // marquer la commande event.data.object.reference comme payée
  }
  res.sendStatus(204)
})
```

Comparaison en temps constant, signature de plus de cinq minutes refusée (le quatrième argument change cette tolérance). Un même événement peut arriver deux fois : servez-vous de `event.id`.

## Erreurs

`AuthenticationError` (401), `PermissionError` (403), `InvalidRequestError` (400, 402, 404, 409, 422, avec `errors` champ par champ), `RateLimitError` (429 après les nouvelles tentatives), `ApiError` (5xx), `ApiConnectionError` (API injoignable ou délai dépassé), `SignatureVerificationError` (webhook). Toutes héritent de `MyAdionError`.

## Nouvelles tentatives et idempotence

Jusqu'à `maxRetries` nouvelles tentatives (2 par défaut), espacées de plus en plus : sur un 429 toujours ; sur un 5xx, un délai dépassé ou une coupure, seulement pour `GET`, `PUT`, `DELETE` et `POST /v1/pay/sessions` (qui porte un `Idempotency-Key`, créé s'il n'est pas fourni). Un remboursement ou un SMS n'est jamais renvoyé après une erreur serveur.

## Mode test

Pas de clé de test ni d'interrupteur : utilisez les identifiants d'une application créée dans une **organisation de test**. Les objets comme les événements portent `livemode: false`. Passer en production, c'est changer d'identifiants (et de secret de webhook), rien d'autre.

## Développement

```bash
npm install
npm test
```

Les tests tournent contre une fausse API locale ; ils n'appellent jamais la vraie.

## Liens

- Guides : [docs.myadion.com](https://docs.myadion.com/api/bibliotheques)
- Référence de l'API : [adion-api.eu](https://adion-api.eu)
- Bibliothèque PHP : [myadion/sdk-php](https://github.com/myadion/sdk-php)

## Licence

MIT, voir [LICENSE](LICENSE).
