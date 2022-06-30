use std::str::FromStr;
use worker::*;

// Urchin Traffic Monitor
#[derive(Default)]
pub struct Utm {
    // Identifies which site sent the traffic, and is a required parameter.
    // Example: Google, YouTube, or rawkode.link
    pub source: String,
    // Identifies what type of link was used, such as cost per click or email.
    pub medium: Option<String>,
    // Identifies a specific product promotion or strategic campaign.
    pub campaign: Option<String>,
    // Identifies search terms.
    // Example: Search Term, Playlist, etc
    pub term: String,
    // Identifies what specifically was clicked to bring the user to the site, such as a banner ad or a text link. It is often used for A/B testing and content-targeted ads.
    // Example: Logo, Text
    pub content: Option<String>,
}

impl Utm {
    fn to_query_string(&self) -> String {
        let mut query_string = format!("utm_source={}", self.source.clone());
        query_string = format!("{}&utm_term={}", query_string, self.term.clone());

        if let Some(medium) = self.medium.clone() {
            query_string = format!("{}&utm_medium={}", query_string, medium);
        }

        if let Some(campaign) = self.campaign.clone() {
            query_string = format!("{}&utm_campaign={}", query_string, campaign);
        }

        if let Some(content) = self.content.clone() {
            query_string = format!("{}&utm_content={}", query_string, content);
        }

        query_string
    }
}

pub struct Link {
    pub url: &'static str,
    pub utm: Utm,
}

fn get_link(hostname: &str, path: &str) -> Link {
    console_log!("Request for {} and {}", hostname, path);

    let default_utm: Utm = Utm {
        source: hostname.to_string(),
        medium: None,
        campaign: None,
        term: path.to_string(),
        content: None,
    };

    match hostname {
        "rawkode.link" => match path {
            "office-hours" => Link {
                url: "https://savvycal.com/rawkode/office-hours",
                utm: default_utm,
            },
            unknown_path => {
                console_log!(
                    "404: Unknown path requested on rawkode.link: '{}'",
                    unknown_path
                );

                Link {
                    url: "https://twitter.com/rawkode",
                    utm: default_utm,
                }
            }
        },

        _ => {
            console_log!("404: Unknown hostname requested: '{}'", &hostname);

            Link {
                url: "https://twitter.com/rawkode",
                utm: default_utm,
            }
        }
    }
}

#[event(fetch)]
pub async fn main(request: Request, _env: Env, _ctx: worker::Context) -> Result<Response> {
    let url = match request.url() {
        Ok(url) => url,
        Err(error) => {
            console_error!("500: Failed to get requested URL: {}", error);

            return Response::error(
                "Sorry, there was a backend error and the process failed to get the requested URL",
                http::StatusCode::INTERNAL_SERVER_ERROR.as_u16(),
            );
        }
    };

    let host: &str = match url.host_str() {
        Some(host) => host,
        None => {
            console_error!(
                "500: Failed to get requested hostname from '{:?}'",
                &url.host_str()
            );

            return Response::error(
                "Sorry, there was a backend error and the process failed to get the requested hostname",
                http::StatusCode::INTERNAL_SERVER_ERROR.as_u16(),
            );
        }
    };

    let path = &request.path().clone();
    let short_link = path.strip_prefix("/").unwrap_or_else(|| path);

    let link = get_link(host, short_link);

    let mut redirect_to = match Url::from_str(link.url) {
        Ok(url) => url,
        Err(error) => {
            console_error!(
                "500: Unable to redirect short link due to bad URL '{}': {}",
                link.url,
                error
            );

            return Response::error(
                format!("Sorry, but we failed to redirect you to '{}'", link.url),
                http::StatusCode::BAD_REQUEST.as_u16(),
            );
        }
    };

    let query_string = link.utm.to_query_string();
    let query_string = match query_string.as_str() {
        "" => None,
        qs => Some(qs),
    };

    redirect_to.set_query(query_string);

    console_log!(
        "URL is {:?} - {}",
        query_string.clone(),
        query_string.unwrap().to_string()
    );

    Response::redirect(redirect_to)
}
