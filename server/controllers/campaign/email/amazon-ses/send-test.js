const AWS = require('aws-sdk');
const db = require('../../../../models');
const AmazonEmail = require('./amazon');
const { wrapLink, insertUnsubscribeLink, insertTrackingPixel } = require('./analytics');
const mailMerge = require('./mail-merge');

const campaignPermission = require('../../../permissions/acl-lib/acl-campaign-permissions');

module.exports = (req, res) => {

  let userId = '';

  const access = campaignPermission(req.cookies.user, req.user.id)
    .then(userIdAndCampaigns => {
      // userIdAndCampaigns.userId must equal 'Write'
      if (userIdAndCampaigns.campaigns !== 'Write') {
        throw 'Permission denied';
      } else {
        userId = userIdAndCampaigns.userId;
        return null;
      }
    });

  Promise.all([access])
    .then(() => {
    // BEGIN ACCESS CONTROL

    const { testEmail, campaignId } = req.body;

    let campaign = {}; // eslint-disable-line
    let amazonSettings = {}; // eslint-disable-line

    const campaignBelongsToUser = new Promise((resolve, reject) => {
      return db.campaign.findOne({
        where: {
          id: campaignId,
          userId
        }
      }).then(campaignInstance => {
        if (!campaignInstance) {
          reject();
          res.status(401).send();
        } else {
          const campaignObject = campaignInstance.get({ plain:true });
          const listId = campaignObject.listId;
          const {
            fromName,
            fromEmail,
            emailSubject,
            emailBody,
            type,
            name,
            trackLinksEnabled,
            trackingPixelEnabled,
            unsubscribeLinkEnabled
          } = campaignObject;

          campaign = {
            listId,
            fromName,
            fromEmail,
            emailSubject,
            emailBody,
            campaignId,
            type,
            name,
            trackLinksEnabled,
            trackingPixelEnabled,
            unsubscribeLinkEnabled
          };

          resolve();
        }
      }).catch(err => {
        reject();
        throw err;
      });
    });

    const getAmazonKeysAndRegion = new Promise((resolve, reject) => {
      return db.setting.findOne({
        where: {
          userId: userId
        }
      }).then(settingInstance => {
        if (!settingInstance) {
          // This should never happen as settings are created on account creation
          reject();
          res.status(500).send();
        } else {
          const settingObject = settingInstance.get({ plain:true });
          const {
            amazonSimpleEmailServiceAccessKey: accessKey,
            amazonSimpleEmailServiceSecretKey: secretKey,
            region,
            whiteLabelUrl
          } = settingObject;
          // If either key is blank, the user needs to set their settings
          if ((accessKey === '' || secretKey === '' || region === '') && process.env.NODE_ENV === 'production') {
            res.status(400).send({ message:'Please provide your details for your Amazon account under "Settings".' });
            reject();
          } else {
            // handling of default whitelabel url?
            amazonSettings = { accessKey, secretKey, region, whiteLabelUrl };
            resolve();
            return null;
          }
        }
      }).catch(err => {
        reject();
        res.status(500).send(err);
      });
    });

    Promise.all([campaignBelongsToUser, getAmazonKeysAndRegion])
      .then(() => {

        const { accessKey, secretKey, region, whiteLabelUrl } = amazonSettings;

        const isDevMode = process.env.NODE_ENV === 'development' || false;

        const ses = isDevMode
          ? new AWS.SES({ accessKeyId: accessKey, secretAccessKey: secretKey, region, endpoint: 'http://localhost:9999' })
          : new AWS.SES({ accessKeyId: accessKey, secretAccessKey: secretKey, region });

        // Modify email body for analytics
        if (campaign.trackLinksEnabled) {
          campaign.emailBody = wrapLink(campaign.emailBody, 'example-tracking-id', campaign.type, whiteLabelUrl);
        }
        if (campaign.trackingPixelEnabled) {
          campaign.emailBody = insertTrackingPixel(campaign.emailBody, 'example-tracking-id', campaign.type);
        }
        if (campaign.unsubscribeLinkEnabled) {
          campaign.emailBody = insertUnsubscribeLink(campaign.emailBody, 'example-unsubscribe-id', campaign.type, whiteLabelUrl);
        }

        // Get custom/additional data (extra columns) needed for mail merge feature
        db.list.findById(campaign.listId, {
          attributes: ['additionalFields'],
          raw: true
        }).then(list => {
          // Add sample/example data to the custom fields
          const additionalData = list.additionalFields.reduce((additionalData, field) => {
            additionalData[field] = `EXAMPLE ${field}`;
            return additionalData;
          }, {});
          campaign.emailBody = mailMerge({ email: testEmail, additionalData }, campaign);

          const emailFormat = AmazonEmail({ email: testEmail }, campaign);

          ses.sendEmail(emailFormat, err => {
            if (err)
              res.status(400).send(err);
            else
              res.send();
          });
        });
      })
    .catch(err => {
      res.status(500).send(err);
      throw err;
    });

  // END ACCESS CONTROL
  })
  .catch(err => {
    res.status(400).send(err);
  });

};
